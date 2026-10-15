# Pi TWebui

Pi 终端会话的浏览器界面。终端和页面共用同一次会话：终端里继续操作，页面里阅读完整 Markdown、复制内容，并直接发送消息。

在 Pi 里按 `Alt+G`，或输入 `/gui`，即可打开。Windows 上会用 `chrome --app` 打开一个没有标签栏和地址栏的窗口；macOS 和 Linux 使用系统默认的打开方式。页面只监听 `127.0.0.1`，地址里带一次性 token。

## 安装

Pi 会自动加载用户扩展目录里带 `index.ts` 的子目录。把本仓库克隆到那里，再安装页面依赖：

```bash
git clone https://github.com/MouthsheepZZZ/pi_twebui.git ~/.pi/agent/extensions/pi-twebui
cd ~/.pi/agent/extensions/pi-twebui
npm install
```

Windows 上的目录是 `%USERPROFILE%\.pi\agent\extensions\pi-twebui`。

然后在正在运行的 Pi 里执行一次 `/reload`。扩展由 Pi 直接加载 TypeScript，不需要单独编译。`npm install` 只安装浏览器端用到的库（Markdown、KaTeX、Mermaid、代码高亮）。`@earendil-works/pi-coding-agent`、`pi-ai` 和 `pi-tui` 来自已安装的 Pi。

也可以不放进自动加载目录，启动时指定路径：

```bash
pi --extension /path/to/pi-twebui
```

## 页面能做什么

- 用 GitHub Flavored Markdown 渲染回复，包括表格、脚注、任务列表、KaTeX 公式和 Mermaid 图，代码块有语法高亮。
- 复制代码块、表格（TSV 或 Markdown）、Mermaid 源码，以及整段回复。复制时使用 CRLF 换行。
- 工具调用默认折叠。`edit` 和 `write` 展开后显示 diff。
- 颜色跟随 Pi 当前的终端主题。
- 粘贴或拖入图片时，会像终端 `Ctrl+V` 一样写成临时文件，并把路径插入输入框，同时显示缩略图。
- 输入 `/` 补全命令，输入 `@` 补全文件。方向键移动时立刻填入候选项，回车发送；Tab 只完成补全。
- 快捷键读取 Pi 当前生效的键位，包括 `keybindings.json` 里的覆盖。
- 页脚显示工作目录、分支、用量、上下文和模型，和终端页脚一致。
- `/reload` 会重载终端里的扩展，并刷新已经打开的页面。

输入框旁边有两个按钮：Fill 把文字放进终端编辑器，Send 发送。Pi 正在运行时，回车会把消息作为 steer 送进当前回合。

页面里的内置命令：`/new`、`/clone`、`/compact`、`/model`、`/thinking`、`/name`、`/session`、`/tree`、`/fork`、`/resume`、`/copy`、`/hotkeys`、`/reload`、`/quit`。

这些命令的界面只在终端里：`/settings`、`/scoped-models`、`/login`、`/logout`、`/export`、`/import`、`/share`、`/bug`、`/changelog`、`/trust`。`!` 开头的 shell 模式也只在终端里。

## 限制

- 图片路径只在本机有效。Pi 和浏览器需要在同一台机器上。
- 已排队的消息只能在终端里恢复到编辑器。
- 浏览器可能先截获自己的保留快捷键。`chrome --app` 窗口没有地址栏，因此 `Ctrl+L` 可以打开模型选择。
- 多行编辑对话框只能在终端里完成。页面上的 Esc 不会关闭扩展弹出的对话框，也不会在对话框还开着时打断 Pi。
- 页面通过包装终端的 `ctx.ui` 来同步状态。这不是 Pi 的公开 RPC。Pi 升级后如果内部界面变了，页面上对应的状态可能停止更新，终端本身不受影响。
- 刷新页面会保留输入框草稿，但会丢掉工具展开状态、思考块的显示选择和图片放大。
