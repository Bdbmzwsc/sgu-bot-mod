# SGU 机器人与网页地图

两件程序配合使用：Fabric 模组跑在 Minecraft 26.1.2 服务器里，Node 服务负责 QQ 机器人和网页俯视图。

## 模组

需要 Java 25 和 Gradle 9.4 以上。在 `mod` 目录执行：

```
gradle build
```

把 `build/libs/sgu-bridge-1.0.0.jar` 放进 `mods`，同时安装 Fabric API 和 Carpet 26.1。第一次启动会在 `config/sgu-bridge/` 生成：

- `config.json`：本机端口和共享密钥
- `command-allowlist.txt`：远程指令白名单，默认只有 `list`
- `records.json`：假人、下线和死亡记录

接口只监听 `127.0.0.1`。下线假人走单独接口，不会经过白名单；其它远程指令必须命中白名单。

## 机器人与地图

在 `service` 目录复制 `.env.example` 为 `.env`，填入 QQ 开放平台的 `APP_ID`、`APP_SECRET`，以及模组 `config.json` 里的 token。世界目录默认是 `/server/world`，地图读取：

- `dimensions/minecraft/overworld/region`
- `dimensions/minecraft/the_nether/region`
- `dimensions/minecraft/the_end/region`

```
npm install
npm start
```

网页在 `http://127.0.0.1:8880/`。指令面板里的地图链接必须是 `https://` 开头，所以 `MAP_PUBLIC_URL` 要写成公网地址。`ALLOWED_GROUP_OPENIDS` 为空时响应所有群，日志里会打印群 OpenID。

群里 `@机器人` 后可用：`假人`、`下线`、`下线坐标 玩家名`、`死亡 玩家名`、`执行 指令`、`地图`、`zt add <地址>`、`zt pending`、`zt all`。`下线`、`执行`、`zt pending`、`zt all` 只接受群主或管理员。

## ZeroTier 授权

在 `service/.env` 里填自建 controller 的 `ZT_NETWORK_ID` 和 `ZT_TOKEN`（`/var/lib/zerotier-one/authtoken.secret` 的内容），`ZT_URL` 默认 `http://127.0.0.1:9993`。两份数据都是简单的 `QQ → 地址` 映射：`data/zerotier-members.json` 是已授权映射，`data/zerotier-requests.json` 是待审名单。

- 普通成员：`zt add <10位地址>` 提交或覆盖自己的申请。
- 管理员：`zt add <地址>` 通过该地址的申请（没有申请时授权自己）；`zt add @成员` 通过该成员的申请；`zt add <地址> @成员`（顺序随意）直接授权；`zt pending` 查看待审；`zt all` 全部通过。
- 通过新地址时会把该成员旧地址一并踢出（`authorized: false`）。同一地址被其他成员占用时直接拒绝。
