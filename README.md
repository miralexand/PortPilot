# PortPilot

PortPilot 是一个 Windows 桌面 TCP 转发管理工具。它提供系统托盘和图形界面，用 HAProxy 在本机网卡端口与目标地址之间转发 TCP 流量。

## 功能

- 选择本机源网卡 IPv4 地址和监听端口
- 目标支持远程 IPv4 地址，或本机另一块网卡
- 添加、编辑、删除、启用和停用转发规则
- 启动、停止和重启 HAProxy
- 对规则的本机端口和目标端口进行连通性测试
- 查看实时运行日志和生成的 HAProxy 配置
- 系统托盘控制、开机自启、关闭到托盘
- 规则和设置自动持久化

## 使用

1. 启动 PortPilot。
2. 点击“添加规则”。
3. 选择源网卡，填写监听端口。
4. 选择目标类型：
   - 远程地址：填写目标 IPv4 地址和目标端口。
   - 本机另一网卡：选择另一块本机网卡的 IPv4 地址，填写目标端口。
5. 保存并启用规则。
6. 点击“启动转发”。

其他设备可通过 `源网卡 IP:监听端口` 访问。首次监听网卡端口时，如 Windows 防火墙弹出提示，请允许 HAProxy 访问网络。

选择“本机另一网卡”时，该网卡地址上的目标端口需要已有服务监听。远程目标不做网段限制，请只配置可信地址。

规则和设置保存在 `%APPDATA%\PortPilot`。

## 开发

要求：

- Windows 10/11
- Node.js 22.12 或更高版本

安装依赖并运行：

```bash
npm install
npm start
```

运行测试：

```bash
npm test
npm run test:e2e
npm run test:ui
```

`test:e2e` 会实际启动 HAProxy 验证 TCP 转发；`test:ui` 需要可用的 Windows 图形会话。

构建 Windows 安装包和便携版：

```bash
npm run dist
```

产物位于 `dist` 目录。

## 发布

推送形如 `0.*` 的 Git tag 会触发 GitHub Actions，在 Windows 环境运行测试、构建安装包并发布到 GitHub Releases。

## HAProxy

应用内置 HAProxy 3.2.23 Windows 运行文件。许可证和构建来源见 `resources/haproxy/`。

## 目录结构

```text
electron/           Electron 主进程、托盘、IPC 和核心逻辑
renderer/           图形界面
resources/haproxy/  内置 HAProxy 运行时和许可证
test/               单元测试、端到端测试和界面冒烟测试
assets/             应用和托盘图标
```
