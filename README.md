# ChatGPT 会话批量管理 Chrome 扩展

这个扩展会在 `chatgpt.com` 左侧历史会话列表里加入复选框和批量操作条，用于多选并批量删除会话。

## 安装

1. 打开 Chrome 的 `chrome://extensions/`。
2. 打开右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」。
4. 选择本目录的 `extension` 文件夹。
5. 刷新 `https://chatgpt.com/`。

## 使用

- 勾选左侧历史会话前面的复选框。
- 点击「删除」。
- 在确认框中确认后，扩展会逐个删除会话。

## 说明

- 删除动作会优先使用 `PATCH /backend-api/conversation/{conversation_id}`，请求体为 `{ "is_visible": false }`。
- 如果 ChatGPT 后续调整接口或 DOM 结构，可能需要更新 `content.js` 中的选择器或接口路径。
- 删除失败时，页面会提示失败数量，详细错误会输出到 DevTools Console。
