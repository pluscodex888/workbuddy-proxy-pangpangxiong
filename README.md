# workbuddy反代胖胖熊助手

![workbuddy反代胖胖熊助手。原生会话、SSE 续读、本地独立运行。](docs/media/workbuddy-pangpangxiong-banner.webp)

## Telegram 交流群

<img src="docs/media/telegram-group-qr.png" alt="Telegram 交流群邀请二维码" width="192">

[加入 Telegram 群](https://t.me/+aRonJd4M4ow0MGY1)

## 交流 QQ 群

<img src="docs/media/qq-community-qr.png" alt="交流 QQ 群 794944238 的二维码" width="192">

用手机 QQ 扫码，或搜索群号 **794944238**。

## 赞助商

**novecloud** 提供自研加密隧道。新人首月送 **200G 流量**免费体验。

QQ群 **555657982** · [novecloud 官网](https://n.novecd.com/)

## 项目介绍

一个本机原生会话桥接库，提供带鉴权的 HTTP API、会话与请求指纹、持久化事件及 SSE 续读。宿主提供已获授权的原生会话服务和可信身份，桥接层沿用宿主的工具审批流程。

开源版支持在独立的 WorkBuddy 窗口登录和使用会话。本机接口只监听回环地址，使用安装时生成的密钥鉴权。连接中断后，可从上次收到的事件继续读取。

公开版采用 MIT 许可证，适用于本仓库的原创代码。Windows 安装器使用本机已有的 WorkBuddy 桌面客户端，启动独立的应用数据目录。WorkBuddy 客户端由其发行方单独提供。

## Windows 安装和启动

1. 安装 Node.js 22.16 或更新版本，并准备 WorkBuddy AI **5.7.6**。安装程序会检查这一版本受支持的文件指纹。
2. 在 GitHub Releases 下载 `workbuddy-pangpangxiong-0.3.1-setup.exe`，运行安装向导，选择 `WorkBuddyAI.exe`、工作目录和本机端口。
3. 从 Windows 开始菜单打开 **WorkBuddy 胖胖熊助手**。在独立 WorkBuddy 窗口使用官方登录界面。启动端口和状态会输出在控制台，也可在安装目录运行 `npm run status` 查询。

源码 ZIP 也可以安装。解压后运行 `Install.cmd` 并选择 WorkBuddy 安装位置，再运行 `Start.cmd`。

安装默认写入当前用户的 `%LOCALAPPDATA%\WorkBuddyPangPangXiong`。本机服务凭据由安装程序随机生成，保存在该目录的 `service-token` 中。客户端从本机读取，作为 Bearer 凭据使用。运行数据和会话记录保存在受当前用户权限保护的 `state` 子目录。

配置文件 `config.json` 保存官方安装位置、允许使用的工作目录和端口。关闭独立窗口后可以重新运行安装更新配置，已有会话和本机服务凭据继续使用。例如在解压目录的 PowerShell 中运行：

```powershell
.\Install.cmd --workbuddy-root 'C:\Program Files\WorkBuddyAI' --workspace 'C:\MyWorkspace' --port 0
```

`--port 0` 让系统分配端口，程序只监听本机回环。用 `npm run check:workbuddy -- --workbuddy-root '<安装目录>'` 可以仅核对版本和文件指纹。

## 从源码构建 NSIS 安装包

在 Windows 上安装 NSIS **3.12** 后，在源码根目录执行：

```powershell
npm run build:nsis
```

默认生成 `dist/workbuddy-pangpangxiong-0.3.1-setup.exe`。用 `--makensis '<makensis.exe 路径>'` 指定编译器，用 `--output '<新 EXE 路径>'` 修改输出位置，两个选项都放在 `npm run build:nsis --` 后面。

- [安装向导源码](installer/workbuddy-public.nsi)
- [构建脚本](scripts/build-public-nsis.mjs)
- [安装器载荷清单](installer/public-files.json)

安装器使用当前用户权限，安装时从本机读取 WorkBuddy 路径。卸载会移除安装目录中的发布文件和对应的开始菜单入口，保留本机工作目录、配置和会话数据。

### 用本地资源构建单文件离线安装器

准备本机已有的 WorkBuddy AI 5.7.6 Windows x64 原始安装器，以及包含 `7z.exe`、`7z.dll` 和 `License.txt` 的 7-Zip 26.06 目录。下列命令从源码根目录运行。请将前三个路径换成本机位置，暂存目录使用新目录，并预留约 3 GB 空间。

```powershell
$installer = 'C:\Installers\WorkBuddy-5.7.6-x64.exe'
$tools = 'C:\Program Files\7-Zip'
$stage = 'C:\Build\workbuddy-5.7.6'
$seven = Join-Path $tools '7z.exe'
$archive = Join-Path $stage 'app-64.7z'
$runtime = Join-Path $stage 'WorkBuddyAI'
& $seven e $installer '$PLUGINSDIR\app-64.7z' "-o$stage"
if ($LASTEXITCODE) { throw '无法提取 WorkBuddy 安装载荷' }
& $seven x $archive "-o$runtime"
if ($LASTEXITCODE) { throw '无法解包 WorkBuddy 安装载荷' }
npm run build:nsis -- --local-workbuddy-root $runtime `
  --local-runtime-archive $archive `
  --local-runtime-sha256 6af222cb354c160b5b51702548c252813200fe360e1e38dde2f77ca31d175f8e `
  --local-extractor-root $tools
```

生成的 `dist/workbuddy-pangpangxiong-0.3.1-offline-setup.exe` 含客户端载荷，安装时校验后解包。客户端资源来自上述原始安装器，账号、配置和会话数据由安装后的独立实例生成。运行仍需本机 Node.js 22.16 或更新版本。公开发布的安装器使用本机已有的 WorkBuddy 客户端。

## 运行模拟测试

安装 Node.js 22.16 或更新版本后运行 `npm test`。测试使用合成数据和本机回环连接，无需 npm 运行时依赖、WorkBuddy 登录或模型请求。

## Node.js 库集成

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
