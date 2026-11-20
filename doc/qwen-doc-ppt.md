# Qwen-Doc-Turbo PPT

`office.create_presentation` 已接入阿里云百炼 `qwen-doc-turbo`，用于根据文本、
本地文档或 Bailian file ID 生成原生 `.pptx`。

## 调用链

`provider=auto` 时，复杂演示文稿：

```text
qwen-doc-turbo（已配置 API Key）
  -> CYRVIS_DOCUMENT_API_URL
  -> 明确失败
```

复杂需求不再降级成本机单页 PowerPoint。基础需求在云端不可用时可继续尝试
本机 Microsoft PowerPoint。

也可以通过 `provider` 强制选择：

- `qwen-doc`
- `powerpoint`
- `remote-api`

## 配置

```env
CYRVIS_QWEN_DOC_API_KEY=
CYRVIS_QWEN_DOC_WORKSPACE_ID=
# 可选；没有显式配置时使用北京地域 Workspace URL 或 DashScope 通用兼容地址
# CYRVIS_QWEN_DOC_BASE_URL=https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
CYRVIS_QWEN_DOC_MODEL=qwen-doc-turbo
CYRVIS_QWEN_DOC_TIMEOUT_MS=600000
```

API Key 查找顺序：

1. `CYRVIS_QWEN_DOC_API_KEY`
2. 应用中与 DashScope 兼容的会话 API Key
3. `DASHSCOPE_API_KEY`
4. `QWEN_API_KEY`

`qwen-doc-turbo` PPT 当前属于华北 2（北京）地域。阿里云账号要求
Workspace-specific URL 时，请填写 `CYRVIS_QWEN_DOC_WORKSPACE_ID` 或
`CYRVIS_QWEN_DOC_BASE_URL`。

## 参数

```json
{
  "path": "桌面/年度规划.pptx",
  "title": "年度产品规划",
  "subtitle": "2027 路线图",
  "content": "用于生成 PPT 的完整源文本",
  "sourcePath": "文档/产品规划.docx",
  "sourceFileId": "file-xxx",
  "mode": "general",
  "templateId": "thesis_01",
  "pageCount": 12,
  "audience": "管理层",
  "provider": "auto"
}
```

- `content`、`sourcePath`、`sourceFileId` 三选一。`sourcePath` 支持文本、
  DOCX、PPTX 和 XLSX。
- `general` 模板模式支持：`news_01`、`summary_01`、`internet_01`、
  `thesis_01`。
- `creative` 创意模式不指定模板，当前工具支持文本、`sourcePath` 和
  `sourceFileId`。百炼协议还支持公网 `doc_url`，但本工具暂不接收任意公网文档。
- `fileId` 会自动切换到 `creative` 模式，因为 API 的文件 ID 输入只支持创意模式。

## 协议实现

请求使用 OpenAI-compatible 流式 Chat Completions：

```json
{
  "model": "qwen-doc-turbo",
  "messages": [
    { "role": "system", "content": "presentation-generation assistant" },
    { "role": "system", "content": "文档内容或 fileid://..." },
    { "role": "user", "content": "生成一个 12 页左右的中文 PPT" }
  ],
  "skill": [
    {
      "type": "ppt",
      "mode": "general",
      "template_id": "thesis_01"
    }
  ],
  "stream": true,
  "stream_options": { "include_usage": true }
}
```

流式响应中：

- `reasoning_content`：PPT 大纲和逐页 HTML。
- `content`：生成完成后的 PPT 下载 URL。

客户端只提取最终 URL，限制下载文件为 50 MB，校验 ZIP/PPTX 文件头后再写入目标。
下载链接和 API Key 不进入工具播报或运行轨迹。

## 安全边界

- PPT 生成属于写入操作，已有目标文件会先自动备份，再直接写入。
- 本地文档先由 `document.extract_text` 提取，再发送到 API。
- 源文本超过 20,000 字符时拒绝直接发送，避免超过文本输入 Token 限制；
  大文档应使用 `sourceFileId`。
- 远端返回非 PPTX ZIP 内容时不会落盘为成功结果。
- API Key、签名下载 URL 不写入运行记忆和 trace。
