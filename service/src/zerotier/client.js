const TIMEOUT_MS = 15_000;

export function createZtClient(config, fetchImpl = fetch) {
	let base = String(config.ztUrl || "http://127.0.0.1:9993");
	while (base.length > 1 && base.endsWith("/")) {
		base = base.slice(0, -1);
	}
	const networkId = String(config.ztNetworkId || "").trim();
	const token = String(config.ztToken || "");

	function enabled() {
		return Boolean(networkId && token);
	}

	function memberUrl(address) {
		return base + "/controller/network/" + networkId + "/member/" + address;
	}

	async function call(method, url, body) {
		let response;
		try {
			response = await fetchImpl(url, {
				method,
				headers: body === undefined
					? { "X-ZT1-Auth": token }
					: { "X-ZT1-Auth": token, "Content-Type": "application/json; charset=utf-8" },
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
		} catch (error) {
			const wrapped = new Error("连不上 ZeroTier controller（" + base + "）：" + error.message);
			wrapped.status = 0;
			throw wrapped;
		}
		const text = await response.text();
		let data = {};
		if (text) {
			try {
				data = JSON.parse(text);
			} catch {
				data = { message: text };
			}
		}
		if (!response.ok) {
			const error = new Error(zeroTierMessage(response.status, data));
			error.status = response.status;
			error.data = data;
			throw error;
		}
		return data;
	}

	return {
		enabled,
		base,
		networkId,
		async authorize(address) {
			const data = await call("POST", memberUrl(address), { authorized: true });
			return memberView(data, address);
		},
		async revoke(address) {
			try {
				await call("POST", memberUrl(address), { authorized: false });
			} catch (error) {
				if (error.status === 404) {
					return;
				}
				throw error;
			}
		},
		async remove(address) {
			await call("DELETE", memberUrl(address));
		},
	};
}

function memberView(data, address) {
	const row = data && typeof data.config === "object" && data.config ? data.config : {};
	const list = Array.isArray(row.ipAssignments)
		? row.ipAssignments
		: Array.isArray(data && data.ipAssignments) ? data.ipAssignments : [];
	return {
		address: String((data && data.address) || address),
		authorized: !data || data.authorized !== false,
		ipAssignments: list.map((ip) => String(ip)),
	};
}

function zeroTierMessage(status, data) {
	if (status === 401 || status === 403) {
		return "ZeroTier 令牌无效或没有权限，请检查 ZT_TOKEN。";
	}
	if (status === 404) {
		return "ZeroTier 找不到这个网络或成员，请检查 ZT_NETWORK_ID。";
	}
	if (status >= 500) {
		return "ZeroTier controller 出错（" + status + "）。";
	}
	return (data && (data.message || data.error)) || "ZeroTier 接口 " + status;
}
