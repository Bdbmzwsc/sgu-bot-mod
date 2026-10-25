const ADDRESS = /^[0-9a-f]{10}$/i;

export function createZtService({ client, store }) {
	async function request(actor, address) {
		if (!client.enabled()) {
			return { kind: "unconfigured" };
		}
		if (!actor || !actor.id) {
			return { kind: "no_identity" };
		}
		const addr = normalizeAddress(address);
		if (!addr) {
			return { kind: "usage" };
		}
		const owners = await store.findOwners(addr);
		if (owners.some((owner) => owner.id !== actor.id)) {
			return { kind: "conflict", address: addr };
		}
		const previous = await store.request(actor.id);
		const member = await store.member(actor.id);
		await store.setRequest(actor.id, addr);
		const replaced = previous && previous !== addr ? previous : "";
		if (member) {
			return { kind: "updated_authorized", address: addr, current: member, replaced };
		}
		return { kind: "requested", address: addr, replaced };
	}

	async function adminAdd({ actor, address, target }) {
		if (!client.enabled()) {
			return { kind: "unconfigured" };
		}
		const addr = address ? normalizeAddress(address) : "";
		if (address && !addr) {
			return { kind: "usage" };
		}
		if (!addr && !target) {
			return { kind: "usage" };
		}
		if (!addr && target) {
			if (!target.id) {
				return { kind: "no_identity" };
			}
			const pending = await store.request(target.id);
			if (!pending) {
				return { kind: "no_request", target };
			}
			return approve({ target, address: pending });
		}
		if (addr && target) {
			if (!target.id) {
				return { kind: "no_identity" };
			}
			return approve({ target, address: addr });
		}
		const owners = await store.findOwners(addr);
		const pendingOwner = owners.find((owner) => owner.kind === "request");
		if (pendingOwner) {
			return approve({ target: { id: pendingOwner.id }, address: addr });
		}
		if (owners.some((owner) => owner.id !== actor.id)) {
			return { kind: "conflict", address: addr };
		}
		return approve({ target: actor, address: addr });
	}

	async function approve({ target, address }) {
		const addr = normalizeAddress(address);
		if (!addr) {
			return { kind: "usage" };
		}
		if (!target || !target.id) {
			return { kind: "no_identity" };
		}
		const owners = await store.findOwners(addr);
		if (owners.some((owner) => owner.id !== target.id)) {
			return { kind: "conflict", address: addr };
		}
		const previousAddress = await store.member(target.id);
		let authorized;
		try {
			authorized = await client.authorize(addr);
		} catch (error) {
			return { kind: "error", address: addr, target, message: error.message };
		}
		let revoked = "";
		let revokeError = "";
		if (previousAddress && previousAddress !== addr) {
			try {
				await client.revoke(previousAddress);
				revoked = previousAddress;
			} catch (error) {
				revokeError = error.message;
			}
		}
		await store.setMember(target.id, addr);
		await store.deleteRequest(target.id);
		return {
			kind: "approved",
			address: addr,
			target,
			previousAddress,
			revoked,
			revokeError,
			ipAssignments: (authorized && authorized.ipAssignments) || [],
		};
	}

	async function approveAll() {
		if (!client.enabled()) {
			return { kind: "unconfigured" };
		}
		const rows = await store.allRequests();
		const done = [];
		const failed = [];
		for (const row of rows) {
			const result = await approve({ target: { id: row.id }, address: row.address });
			if (result.kind === "approved") {
				done.push(result);
			} else {
				failed.push({ id: row.id, address: row.address, message: failureMessage(result) });
			}
		}
		return { kind: "all", done, failed };
	}

	async function listPending() {
		if (!client.enabled()) {
			return { kind: "unconfigured", rows: [] };
		}
		const rows = await store.allRequests();
		rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
		return { kind: "pending", rows };
	}

	return { request, adminAdd, approveAll, listPending };
}

function normalizeAddress(address) {
	const text = String(address || "").trim();
	return ADDRESS.test(text) ? text.toLowerCase() : "";
}

function failureMessage(result) {
	if (result.kind === "conflict") return "地址已被其他成员占用";
	if (result.kind === "usage") return "地址无效";
	if (result.kind === "no_identity") return "缺少成员身份";
	if (result.kind === "error") return result.message;
	return "未通过";
}
