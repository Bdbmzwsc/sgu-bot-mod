import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export function createZtStore({ dataDir }) {
	const membersFile = path.join(dataDir, "zerotier-members.json");
	const requestsFile = path.join(dataDir, "zerotier-requests.json");
	const members = new Map();
	const requests = new Map();
	let loading = null;

	async function load() {
		if (!loading) {
			loading = loadOnce();
		}
		return loading;
	}

	async function loadOnce() {
		const [savedMembers, savedRequests] = await Promise.all([readJson(membersFile), readJson(requestsFile)]);
		for (const [id, address] of Object.entries(savedMembers)) {
			if (isAddress(address)) {
				members.set(id, address.toLowerCase());
			}
		}
		for (const [id, address] of Object.entries(savedRequests)) {
			if (isAddress(address)) {
				requests.set(id, address.toLowerCase());
			}
		}
	}

	async function persist(file, rows) {
		await writeJsonAtomic(file, Object.fromEntries(rows));
	}

	return {
		membersFile,
		requestsFile,
		load,
		async member(id) {
			await load();
			return members.get(id) || "";
		},
		async request(id) {
			await load();
			return requests.get(id) || "";
		},
		async allRequests() {
			await load();
			return [...requests].map(([id, address]) => ({ id, address }));
		},
		async allMembers() {
			await load();
			return [...members].map(([id, address]) => ({ id, address }));
		},
		async findOwners(address) {
			await load();
			const wanted = String(address || "").toLowerCase();
			const owners = [];
			for (const [id, value] of members) {
				if (String(value).toLowerCase() === wanted) {
					owners.push({ kind: "member", id });
				}
			}
			for (const [id, value] of requests) {
				if (String(value).toLowerCase() === wanted) {
					owners.push({ kind: "request", id });
				}
			}
			return owners;
		},
		async setMember(id, address) {
			await load();
			members.set(id, address);
			await persist(membersFile, members);
		},
		async setRequest(id, address) {
			await load();
			requests.set(id, address);
			await persist(requestsFile, requests);
		},
		async deleteRequest(id) {
			await load();
			if (requests.delete(id)) {
				await persist(requestsFile, requests);
			}
		},
	};
}

async function readJson(file) {
	try {
		const parsed = JSON.parse(await readFile(file, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

async function writeJsonAtomic(file, body) {
	await mkdir(path.dirname(file), { recursive: true });
	const temporary = file + "." + process.pid + ".tmp";
	await writeFile(temporary, JSON.stringify(body));
	try {
		await rename(temporary, file);
	} catch (error) {
		if (error.code !== "EPERM" && error.code !== "EEXIST") {
			throw error;
		}
		await rm(file, { force: true });
		await rename(temporary, file);
	}
}

function isAddress(address) {
	return typeof address === "string" && /^[0-9a-f]{10}$/i.test(address);
}
