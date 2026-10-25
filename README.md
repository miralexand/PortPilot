# PortPilot

[![License: GPL-2.0-only](https://img.shields.io/badge/license-GPL--2.0--only-blue.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4.svg)](#系统要求)

PortPilot 是一个面向 Windows 的 TCP 端口转发管理工具。它通过系统托盘和图形界面管理转发规则，并调用内置的 HAProxy 在本机网卡端口与目标地址之间转发 TCP 流量。

项目采用与 HAProxy 相同的 GNU General Public License version 2（GPL-2.0-only）开源发布。

## 功能特性

- 选择本机源网卡的 IPv4 地址和监听端口
- 目标支持远程 IPv4 地址，或本机另一块网卡
- 添加、编辑、删除、启用和停用转发规则
- 一键启动、停止和重启 HAProxy
- 测试规则的本机端口与目标端口连通性
- 查看实时运行日志和生成的 HAProxy 配置
- 系统托盘控制、开机自启、关闭到托盘
- 规则和设置自动持久化，异常退出后可恢复
- 内置 HAProxy 运行时，无需单独安装

## 系统要求

- Windows 10 或 Windows 11（x64）
- 安装版无需额外依赖；从源码运行需要 Node.js 22.12 或更高版本

## 下载与安装

从 [GitHub Releases](https://github.com/miralexand/PortPilot/releases) 下载最新版本：

- `PortPilot-<版本>-x64.exe`：NSIS 安装程序，可选择安装目录并创建快捷方式
- `PortPilot-<版本>-portable.exe`：便携版，无需安装

首次监听本机网卡端口时，Windows 防火墙可能弹出提示，请允许 HAProxy 访问网络，否则其他设备无法连接。

## 快速开始

1. 启动 PortPilot。
2. 点击“添加规则”。
3. 选择源网卡，填写监听端口。
4. 选择目标类型：
   - 远程地址：填写目标 IPv4 地址和目标端口。
   - 本机另一网卡：选择另一块本机网卡的 IPv4 地址，填写目标端口。
5. 保存并启用规则。
6. 点击“启动转发”。

完成后，其他设备可通过 `源网卡 IP:监听端口` 访问目标服务。

## 使用说明

- 选择“本机另一网卡”时，目标网卡地址上的目标端口需要已有服务监听。
- 远程目标不受网段限制，请只配置可信地址，避免将内部服务暴露给非预期网络。
- 转发规则仅作用于 TCP；当前版本不处理 UDP 流量。
- 规则和设置保存在 `%APPDATA%\PortPilot`，生成的 HAProxy 配置和日志路径可在应用内查看。
- 可以通过托盘菜单启动/停止转发、打开主界面或退出应用。

## 从源码运行

要求：

- Windows 10/11
- Node.js 22.12 或更高版本
- npm（随 Node.js 一起安装）

安装依赖并启动：

```bash
npm install
npm start
```

开发模式（打开开发者工具）：

```bash
npm run dev
```

## 测试

```bash
npm test          # 单元测试
npm run test:e2e  # 端到端转发测试，会实际启动 HAProxy
npm run test:ui   # 界面冒烟测试，需要可用的 Windows 图形会话
```

## 构建

构建 Windows 安装包和便携版：

```bash
npm run dist
```

仅生成未打包目录：

```bash
npm run pack
```

构建产物位于 `dist` 目录。

## 发布流程

推送形如 `0.*` 的 Git tag 会触发 GitHub Actions。工作流在 Windows 环境运行单元测试、构建安装包与便携版，并发布到 GitHub Releases：

```bash
git tag 0.0.3
git push origin 0.0.3
```

## 目录结构

```text
electron/           Electron 主进程、托盘、IPC 和核心逻辑
renderer/           图形界面
resources/haproxy/  内置 HAProxy 运行时、NOTICE 和许可证
test/               单元测试、端到端测试和界面冒烟测试
assets/             应用和托盘图标
.github/            GitHub Actions 发布工作流
```

## 内置 HAProxy

应用内置 HAProxy 3.2.23 Windows 运行文件（Cygwin x86_64）。版本、构建参数、源码地址和校验值见 [`resources/haproxy/NOTICE.txt`](resources/haproxy/NOTICE.txt) 与 [`resources/haproxy/README.MD`](resources/haproxy/README.MD)。

HAProxy 采用 GNU GPL v2，并附带 OpenSSL 链接例外。相关许可证文本位于：

- [`resources/haproxy/LICENSE`](resources/haproxy/LICENSE)
- [`resources/haproxy/COPYING`](resources/haproxy/COPYING)

内置的 Cygwin、OpenSSL、PCRE2、zlib 和 Lua 运行库分别遵循其各自许可证，来源信息见 `NOTICE.txt`。

## 许可证

PortPilot 采用与 HAProxy 相同的 **GNU General Public License version 2**（`GPL-2.0-only`）发布。

你可以依据自由软件基金会发布的 GPL 第 2 版条款复制、修改和分发本项目。完整许可证文本见根目录 [`LICENSE`](LICENSE)。

本项目按“现状”提供，不附带任何明示或暗示的担保。分发本项目的二进制版本时，应同时提供对应的完整源代码；源代码可通过本仓库获取。

## 参与贡献

欢迎通过 Issue 反馈问题、提出建议，或提交 Pull Request。提交贡献即表示你同意相关内容按本项目的 GPL-2.0-only 许可证发布。

## 免责声明

PortPilot 仅提供端口转发配置与管理能力。请确保你拥有对相关网络、设备和服务的合法管理权限，并自行评估开放端口带来的安全风险。
