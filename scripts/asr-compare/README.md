# 语音识别对比台（scripts/asr-compare）

同一个页面、同一段录音，把 SenseVoiceSmall、几个流式 Zipformer transducer，以及**在线 Whisper**
并排跑一遍，自己听、自己看、自己算错字率。用来回答两个问题：**默认本地模型该不该换**、
**在线模型值不值得用。**

> 这里只是对比台，不改应用里的任何默认值。应用当前仍走本地 SenseVoice。

## 启动

```bash
# 1) 需要 sherpa-onnx-node >= 1.13.8（1.13.4 的流式 transducer 恒返回空串）
npm i sherpa-onnx-node@1.13.8
# 或者指向已经装好的一份：
SHERPA_ONNX_NODE=/path/to/node_modules/sherpa-onnx-node \
  node scripts/asr-compare/server.js

# 2) 打开
open http://127.0.0.1:8899
```

- 只监听 `127.0.0.1`，独立进程，不碰正在跑的 MultiCC 服务，不需要重启服务。
- 端口：`PORT=9000`。模型根目录：`ASR_LOCAL_MODEL_DIR`（默认 `~/.multicc/asr-models`）。
- 页面会先 `/api/warm` 预加载勾选的引擎；首次加载模型约 1–10 秒。

## 在线 ASR

在线部分是一张「服务清单 × 协议适配器」表：每个服务在 `server.js` 的 `PROVIDERS` 里
描述一次（地址、模型、key、说哪种协议），传输层复用同一套代码。加一个同类服务只需要
加一条数据，不用碰解码逻辑。

| id | 服务 | 协议 | 热词方式 |
|---|---|---|---|
| `groq` | Groq Whisper Turbo | `openai-transcriptions` | prompt |
| `openai` | OpenAI gpt-4o-transcribe | `openai-transcriptions` | prompt |
| `siliconflow` | 硅基流动 SenseVoiceSmall（**与本地同模型**） | `openai-transcriptions` | 无 |
| `zhipu` | 智谱 GLM-ASR | `openai-transcriptions` | **原生热词数组** |
| `mistral` | Mistral Voxtral | `openai-transcriptions` | prompt |
| `deepgram` | Deepgram Nova-3 | `deepgram` | keywords 加权 |
| `elevenlabs` | ElevenLabs Scribe | `elevenlabs` | 无 |
| `assemblyai` | AssemblyAI Universal | `assemblyai` | word_boost |
| `qwen` | 阿里 Qwen3-ASR-Flash | `openai-chat-audio` | context 提示 |
| `volc` | 火山豆包流式 2.0 | `volc-sauc`（WebSocket 二进制帧） | **原生热词表** |
| `custom` | 任意 OpenAI 兼容接口 | `openai-transcriptions` | prompt |

### 凭据

读主仓根目录的 `.env`（`ASR_COMPARE_ENV=/path/to/.env` 可改），命名规律
`ASR_<ID>_API_KEY` / `_BASE_URL` / `_MODEL` / `_LANGUAGE`。兼容几个既有名字：

- `groq` 回落到 `WHISPER_API_KEY` / `OPENROUTER_API_KEY`（应用本来就用这几个）
- `siliconflow` 回落 `SILICONFLOW_API_KEY`、`zhipu` 回落 `ZHIPU_API_KEY`
- `qwen` 回落 `DASHSCOPE_API_KEY`、`deepgram` / `elevenlabs` / `assemblyai` 回落同名键
- `volc` 另有 `ASR_VOLC_APP_ID`（可空）和 `ASR_VOLC_RESOURCE_ID`（默认 `volc.bigasr.sauc.duration`）

三种改法，优先级从低到高：

1. `.env`（进程启动时读一次，改完要重启对比台）；
2. 页面上每个服务行点「配置」，填 Base URL / 模型 / Key / 语言 —— 只对本次提交生效，
   留空沿用服务端配置；
3. 直接调接口：`x-cloud-config` 头放 base64 的 `{ <id>: {baseUrl, model, key, language} }`。

`/api/status` 只回 `hasKey: true/false`，**不会把 key 回传给浏览器**；带 `****` 的值
被当成掩码丢弃，不会真的拿去请求。

### 热词的差别（这是重点）

在线服务对热词的支持方式完全不同，卡片上会逐条标出实际用的是哪一种：

- `prompt` / `context`：只是个提示，模型可能完全无视（Whisper 系、Qwen）
- `keywords` / `word_boost`：关键词加权（Deepgram、AssemblyAI）
- `native`：真正的热词表，由服务端参与解码（智谱、火山）

所以「在线 CER 更低」和「在线能修好 `worktree`」是两件不同的事，尽量分开看。

### 已知限制

- **智谱**单段上限 30 秒 / 25MB，超了会直接报错。
- **火山**没有可用的本地批量接口：录音文件识别只接受公网可下载的 URL，本机
  `127.0.0.1` 的音频它取不到。所以这里走的是流式 WebSocket，把整段 PCM 一次推完；
  需要 `ws` 模块（仓库已有，或设 `WS_MODULE=/path/to/ws`）。
- **阿里**的「OpenAI 兼容」并不是 `/audio/transcriptions`，而是
  `/chat/completions` + `input_audio`，所以单独一个协议。
- 火山这条链路是照协议文档实现的，但**尚未用真实凭证跑通过**；其余各家都用
  假 key 验证过「地址正确、返回 401」。

## 页面怎么用

1. **热词**：每行一个。英文会自动转大写（这个模型的词表只有大写英文）。可写
   `MultiCC :5` 给单条加权。
2. **参考文本**：把刚才说的话打进去，每张卡会给出 CER（错字率）和逐字对齐。
3. **热词权重**：0.5–6，越高越容易把热词塞进结果，也越容易幻觉。建议从 3 起，往下试。
4. 点「开始录音」说一句、再点停止；或者「选择音频文件」拿现成 wav 复现。
5. **在线 ASR 服务**是折叠的，点开是一行一个服务；勾选即参与对比，点「配置」
   可临时改地址 / 模型 / Key。`.env` 里有 key 的服务会显示「已配置」并默认勾上。
   没 key 也能勾——现场填一个就行，只用于这一次请求。

## 引擎与实测（2026-10-20，6 句 TTS 基准）

| 引擎 | 体积 | 平均 CER | 备注 |
|---|---|---|---|
| SenseVoiceSmall int8（现状默认） | 239MB | **0.098** | 离线，无解码期热词 |
| Zipformer 双语 2023-02-20 | 198MB | 0.341 | 复读缺陷；英文全大写 |
| Zipformer 中文 2025-06-30 | 167MB | 0.207–0.217 | 词表无 ASCII，读不了英文 |
| Zipformer 多语种 2025-02-10 | 339MB | 0.247–0.255 | 中文最差 |
| 在线 Whisper（Groq `whisper-large-v3-turbo`） | 0MB 本地 | 单句 **0.0** | 联网；延迟见下 |

在线那行是单句样本（最难的那句 `这个 worktree 的 AutoCommit 是不是又开了`），
不是 6 句平均，别直接和上面几行横比。值得记的是：它是**唯一**把 `worktree` 和
`AutoCommit` 两个词都写对的引擎；SenseVoice 给的是 `work trade` / `auto commit`。

延迟（同一句 3.25s 音频，经代理）：

- 冷启动：9.1s / 2.4s
- 热：**0.64s**，与本地 SenseVoice 的 0.3–0.9s 同量级

也就是说在线不是「一定更慢」，而是「网络抖一次就慢一次」，冷启动代价明显。

解码期热词的行为（在页面上可直接复现）：

- 中文热词有效，能把丢掉的尾字补回来（`…聊天记` → `…聊天记录`，context_score 3）。
- 英文热词**必须大写**才编码得进词表；`ALSO COMMIT` → `ALSO AUTOCOMMIT` 能修对。
- 但 `MULTICC` / `WORKTREE` 这类词仍然修不对，权重拉到 3 以上还会往句子里插噪声。
- 权重的代价：分数越高，幻觉越多；`context_score` 只说明命中，不说明命中对了。

## 内存

每个**本地** recognizer 常驻 200–500MB。五个本地引擎全开约 1.5GB；默认三档（sense / bi / bi-hw）
约 800MB。缓存上限 6 个，超出的按 LRU 淘汰。

在线引擎不占本地内存，但每次请求都要把整段音频编码成 16-bit PCM WAV 再上传；
长录音的体积和耗时是线性增长的，别拿它跑几分钟的素材。
