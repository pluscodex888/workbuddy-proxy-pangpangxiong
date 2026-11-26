# workbuddy反代胖胖熊助手

一个本机原生会话桥接库，提供带鉴权的 HTTP API、会话与请求指纹、持久化事件及 SSE 续读。宿主提供已获授权的原生会话服务和可信身份，桥接层沿用宿主的工具审批流程。

公开版采用 MIT 许可证，适用于本仓库的原创代码。接入正式环境需要自备 WorkBuddy 客户端和有权使用的宿主集成。当前版提供源码库，官方客户端、安装包、管理后台和账号迁移组件均独立于此库。

## 运行模拟测试

安装 Node.js 22.16 或更新版本后运行 `npm test`。测试使用合成数据和本机回环连接，无需 npm 运行时依赖、WorkBuddy 登录或模型请求。

## 集成方式

在拥有已授权 `daemon` 的宿主进程中调用 `mountNativeBridge`。`getIdentity` 由宿主实现，并提供 `instanceId`、`ownerId`、`realm` 和 `generation`。`dataRoot` 和 `allowedWorkspaces` 使用绝对路径。运行目录可能包含会话内容，应配置为仅当前服务用户可访问。服务监听 `127.0.0.1`。

```javascript
import { mountNativeBridge } from './src/public-native.mjs';

const bridge = await mountNativeBridge({
  daemon,
  getIdentity,
  dataRoot,
  allowedWorkspaces: [workspace],
  token: localServiceToken,
});
console.log(bridge.url);
```

`localServiceToken` 是宿主配置的独立服务密钥，长度至少为 32 字节。客户端通过 `Authorization: Bearer …` 发送它。结束宿主服务时，先等活动请求结束，再调用 `await bridge.close()`。

| 路径前缀 `/workbaby/v1` | 行为 |
| --- | --- |
| `GET /capabilities` | 查询身份、能力和上限 |
| `POST /sessions` | 创建或恢复固定工作目录的原生会话 |
| `POST /sessions/{id}/turns` | 按请求 ID 提交并获取接收回执 |
| `GET /turns/{id}` | 查询轮次和已落盘的事件序号 |
| `GET /turns/{id}/events` | 订阅 SSE，支持 `Last-Event-ID` 或 `?after=` 续读 |
| `POST /turns/{id}/cancel` | 取消活动轮次 |
| `POST /turns/{id}/approvals/{id}` | 提交宿主支持的工具审批决定 |

创建会话时提供 `externalSessionId`、`cwd`、`executionMode: "native"` 以及 `permissionMode`（`default`、`acceptEdits` 或 `plan`）。提交轮次时提供 `schema: "workbaby.session-turn/v1"`、唯一的 `requestId`、对应的 `externalSessionId`、`executionMode: "native"` 和 `input`，例如 `[{"type":"text","text":"你好"}]`。收到 `in_doubt` 时可查询和续读已有轮次，桥接端不会自动重新发送。

`src/fingerprint.cjs` 对结构化数据生成确定性 SHA-256，供本地核对输入和结果。公开版保留原生模式，连续会话、工具审批和模型可用性取决于宿主环境。默认安装验证标志适用于模拟测试，实际集成需按宿主环境单独验收。
