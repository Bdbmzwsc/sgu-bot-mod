import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createHandler, panelItems } from "../src/bot/handle.js";
import { createZtClient } from "../src/zerotier/client.js";
import { createZtService } from "../src/zerotier/service.js";
import { createZtStore } from "../src/zerotier/store.js";

const A1 = "abcdef1234";
const A2 = "0123456789";
const A3 = "aabbccdd01";

function actor(id, extra = {}) {
	return { id, memberOpenid: id, unionOpenid: "", username: extra.username || id, groupOpenid: "group", ...extra };
}

function fakeClient(overrides = {}) {
	const calls = { authorized: [], revoked: [] };
	return {
		calls,
		enabled: () => true,
		async authorize(address) {
			calls.authorized.push(address);
			if (overrides.failAuthorize) throw new Error(overrides.failAuthorize);
			return { address, ipAssignments: overrides.ipAssignments || ["10.147.17.21"] };
		},
		async revoke(address) {
			calls.revoked.push(address);
			if (overrides.failRevoke) throw new Error(overrides.failRevoke);
		},
	};
}

async function setup(overrides = {}) {
	const dataDir = await mkdtemp(path.join(tmpdir(), "sgu-zt-"));
	const store = createZtStore({ dataDir });
	const client = fakeClient(overrides);
	const service = createZtService({ client, store });
	return { dataDir, store, client, service };
}

test("成员申请可被覆盖，已授权者重申请不改旧映射", async () => {
	const { dataDir, store, service } = await setup();
	const me = actor("u1");
	let result = await service.request(me, A1);
	assert.equal(result.kind, "requested");
	assert.equal(await store.request("u1"), A1);

	result = await service.request(me, A2);
	assert.equal(result.kind, "requested");
	assert.equal(result.replaced, A1);
	assert.equal(await store.request("u1"), A2);

	const approved = await service.adminAdd({ actor: actor("admin"), address: A2, target: null });
	assert.equal(approved.kind, "approved");
	assert.equal(await store.member("u1"), A2);
	assert.equal(await store.request("u1"), "");

	result = await service.request(me, A3);
	assert.equal(result.kind, "updated_authorized");
	assert.equal(result.current, A2);
	assert.equal(await store.member("u1"), A2);
	assert.equal(await store.request("u1"), A3);
	await rm(dataDir, { recursive: true, force: true });
});

test("同一地址被其他成员占用时拒绝", async () => {
	const { dataDir, service } = await setup();
	await service.request(actor("u1"), A1);
	const result = await service.request(actor("u2"), A1);
	assert.equal(result.kind, "conflict");
	await rm(dataDir, { recursive: true, force: true });
});

test("管理员按地址通过申请，覆写时踢出旧地址", async () => {
	const { dataDir, store, client, service } = await setup();
	await service.request(actor("u1"), A1);
	let result = await service.adminAdd({ actor: actor("admin"), address: A1, target: null });
	assert.equal(result.kind, "approved");
	assert.equal(await store.member("u1"), A1);

	await service.request(actor("u1"), A2);
	result = await service.adminAdd({ actor: actor("admin"), address: A2, target: null });
	assert.equal(result.kind, "approved");
	assert.equal(result.revoked, A1);
	assert.deepEqual(client.calls.revoked, [A1]);
	assert.equal(await store.member("u1"), A2);
	await rm(dataDir, { recursive: true, force: true });
});

test("管理员无申请时授权自己，@成员可直接授权", async () => {
	const { dataDir, store, service } = await setup();
	let result = await service.adminAdd({ actor: actor("admin"), address: A1, target: null });
	assert.equal(result.kind, "approved");
	assert.equal(await store.member("admin"), A1);

	result = await service.adminAdd({ actor: actor("admin"), address: A2, target: actor("u9", { username: "小明" }) });
	assert.equal(result.kind, "approved");
	assert.equal(await store.member("u9"), A2);

	result = await service.adminAdd({ actor: actor("admin"), address: "", target: actor("u8") });
	assert.equal(result.kind, "no_request");
	await rm(dataDir, { recursive: true, force: true });
});

test("全部通过会清空待审，控制器失败时不落盘", async () => {
	const { dataDir, store, service } = await setup();
	await service.request(actor("u1"), A1);
	await service.request(actor("u2"), A2);
	const result = await service.approveAll();
	assert.equal(result.kind, "all");
	assert.equal(result.done.length, 2);
	assert.equal((await store.allRequests()).length, 0);
	assert.equal(await store.member("u1"), A1);
	await rm(dataDir, { recursive: true, force: true });

	const failing = await setup({ failAuthorize: "boom" });
	await failing.service.request(actor("u1"), A1);
	const failed = await failing.service.adminAdd({ actor: actor("admin"), address: A1, target: null });
	assert.equal(failed.kind, "error");
	assert.equal(await failing.store.request("u1"), A1);
	assert.equal(await failing.store.member("u1"), "");
	await rm(failing.dataDir, { recursive: true, force: true });
});

test("两份数据只存 qq 到 address 的映射", async () => {
	const dataDir = await mkdtemp(path.join(tmpdir(), "sgu-zt-"));
	const first = createZtStore({ dataDir });
	await first.setRequest("u1", A1);
	await first.setMember("u2", A2);
	const second = createZtStore({ dataDir });
	assert.equal(await second.request("u1"), A1);
	assert.equal(await second.member("u2"), A2);
	const savedRequests = JSON.parse(await readFile(path.join(dataDir, "zerotier-requests.json"), "utf8"));
	const savedMembers = JSON.parse(await readFile(path.join(dataDir, "zerotier-members.json"), "utf8"));
	assert.deepEqual(savedRequests, { u1: A1 });
	assert.deepEqual(savedMembers, { u2: A2 });
	await rm(dataDir, { recursive: true, force: true });
});

test("client 向自建 controller 发送授权请求", async () => {
	const seen = [];
	const client = createZtClient(
		{ ztUrl: "http://127.0.0.1:9993/", ztNetworkId: "8056c2e21c000001", ztToken: "secret" },
		async (url, init) => {
			seen.push({ url, init });
			return new Response(JSON.stringify({ address: A1, authorized: true, config: { ipAssignments: ["10.147.17.21"] } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		},
	);
	const member = await client.authorize(A1);
	assert.equal(seen[0].url, "http://127.0.0.1:9993/controller/network/8056c2e21c000001/member/" + A1);
	assert.equal(seen[0].init.method, "POST");
	assert.equal(seen[0].init.headers["X-ZT1-Auth"], "secret");
	assert.deepEqual(JSON.parse(seen[0].init.body), { authorized: true });
	assert.deepEqual(member.ipAssignments, ["10.147.17.21"]);
});

test("client 报令牌错误，revoke 忽略 404", async () => {
	const bad = createZtClient(
		{ ztUrl: "http://127.0.0.1:9993", ztNetworkId: "8056c2e21c000001", ztToken: "x" },
		async () => new Response("no", { status: 401 }),
	);
	await assert.rejects(() => bad.authorize(A1), /令牌无效/);
	const gone = createZtClient(
		{ ztUrl: "http://127.0.0.1:9993", ztNetworkId: "8056c2e21c000001", ztToken: "x" },
		async () => new Response("no", { status: 404 }),
	);
	await gone.revoke(A1);
});

function fakeService() {
	const calls = { request: [], adminAdd: [], approveAll: 0, listPending: 0 };
	return {
		calls,
		async request(actorValue, address) {
			calls.request.push({ actor: actorValue, address });
			return { kind: "requested", address, replaced: "" };
		},
		async adminAdd(args) {
			calls.adminAdd.push(args);
			return { kind: "approved", address: args.address || A1, target: args.target || args.actor, ipAssignments: [] };
		},
		async approveAll() {
			calls.approveAll += 1;
			return { kind: "all", done: [], failed: [] };
		},
		async listPending() {
			calls.listPending += 1;
			return { kind: "pending", rows: [{ id: "u1", address: A1 }] };
		},
	};
}

function handler(zerotier, access = null) {
	return createHandler({ bridge: {}, config: {}, auditPath: "", access, zerotier });
}

function message(content, options = {}) {
	return {
		group_openid: "group",
		content,
		mentions: options.mentions || [],
		author: {
			member_openid: options.memberOpenid || "me",
			member_role: options.role || "member",
			username: options.username || "我",
		},
	};
}

test("普通成员的 @ 只当普通申请处理", async () => {
	const zt = fakeService();
	const reply = await handler(zt)(message("/zt add " + A1, { mentions: [{ member_openid: "other", username: "别人" }] }));
	assert.equal(zt.calls.adminAdd.length, 0);
	assert.equal(zt.calls.request.length, 1);
	assert.equal(zt.calls.request[0].address, A1);
	assert.match(reply.markdown, /等待管理员/);
});

test("普通成员只 @ 成员时提示用法", async () => {
	const zt = fakeService();
	const reply = await handler(zt)(message("/zt add @别人", { mentions: [{ member_openid: "other", username: "别人" }] }));
	assert.equal(zt.calls.request.length, 0);
	assert.match(reply.markdown, /用法/);
});

test("管理员 address 与 @成员 顺序无关", async () => {
	const zt = fakeService();
	const h = handler(zt);
	await h(message("/zt add " + A1 + " @小明", { role: "admin", mentions: [{ member_openid: "u9", username: "小明" }] }));
	await h(message("/zt add @小明 " + A1, { role: "admin", mentions: [{ member_openid: "u9", username: "小明" }] }));
	assert.equal(zt.calls.adminAdd.length, 2);
	assert.deepEqual(
		zt.calls.adminAdd.map((call) => [call.address, call.target.id]),
		[[A1, "u9"], [A1, "u9"]],
	);
});

test("管理员 @ 无申请成员时提示补地址", async () => {
	const zt = fakeService();
	zt.adminAdd = async (args) => {
		zt.calls.adminAdd.push(args);
		return { kind: "no_request", target: args.target };
	};
	const reply = await handler(zt)(message("/zt add @小明", { role: "admin", mentions: [{ member_openid: "u9", username: "小明" }] }));
	assert.match(reply.markdown, /没有待审申请/);
});

test("管理员只有地址时按地址处理", async () => {
	const zt = fakeService();
	await handler(zt)(message("/zt add " + A1, { role: "admin" }));
	assert.equal(zt.calls.adminAdd.length, 1);
	assert.equal(zt.calls.adminAdd[0].address, A1);
	assert.equal(zt.calls.adminAdd[0].target, null);
});

test("pending 与 all 仅管理员可用", async () => {
	const zt = fakeService();
	const h = handler(zt);
	assert.match((await h(message("/zt pending", { role: "member" }))).markdown, /群主或管理员/);
	assert.equal(zt.calls.listPending, 0);
	await h(message("/zt pending", { role: "owner" }));
	assert.equal(zt.calls.listPending, 1);
	await h(message("/zt all", { role: "admin" }));
	assert.equal(zt.calls.approveAll, 1);
});

test("待审列表优先显示 access 里的昵称", async () => {
	const zt = fakeService();
	const access = { nameOf: (id) => (id === "u1" ? "小明" : "") };
	const reply = await handler(zt, access)(message("/zt pending", { role: "admin" }));
	assert.match(reply.markdown, /小明/);
	assert.match(reply.markdown, new RegExp(A1));
});

test("多个 @ 或多个地址时拒绝", async () => {
	const zt = fakeService();
	const h = handler(zt);
	assert.match(
		(await h(message("/zt add " + A1, { role: "admin", mentions: [{ member_openid: "a" }, { member_openid: "b" }] }))).markdown,
		/只能 @ 一个/,
	);
	assert.match((await h(message("/zt add " + A1 + " " + A2, { role: "admin" }))).markdown, /只能处理一个地址/);
	assert.equal(zt.calls.adminAdd.length, 0);
});

test("指令面板包含 zt", () => {
	assert.ok(panelItems().some((item) => item.name === "zt"));
});
