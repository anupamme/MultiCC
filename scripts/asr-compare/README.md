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

## 在线 ASR 的口子

在线引擎直接复用 MultiCC 的 `.env`，默认读主仓根目录的 `.env`
（`ASR_COMPARE_ENV=/path/to/.env` 可改）。认这几个键：

| 键 | 默认 |
|---|---|
| `WHISPER_BASE_URL` | `https://api.openai.com/v1` |
| `WHISPER_API_KEY` | 无（缺失时回落 `OPENROUTER_API_KEY`） |
| `WHISPER_MODEL` | `whisper-1` |
| `WHISPER_LANGUAGE` | `zh` |

任何 OpenAI 兼容的 `/audio/transcriptions` 都能接：OpenAI、Groq、自建代理都行。
只有「在线」那一项会用到它，本地引擎不联网。

三种改法，优先级从低到高：

1. `.env` 里的 `WHISPER_*`（进程启动时读一次，改完要重启对比台）；
2. 页面「在线 ASR 接口」折叠块里填 Base URL / Model / API Key —— 只对本次提交生效，
   输入框留空则沿用服务端配置；
3. 直接调接口：`x-cloud-config` 头放 base64 的 `{baseUrl, model, key, language}`。

页面的 `/api/status` 只回 `hasKey: true/false`，**不会把 key 回传给浏览器**。
错误里带了 `****` 的 key 会被当成掩码丢弃，不会真的拿去请求。

真正的问题是：**热词在在线这边只能是 prompt 提示，不是解码期偏置。**
所以卡片上会明确标「热词只作为 Whisper prompt 提示，不是解码期偏置」，
它可能帮你把 `AutoCommit` 写对，也可能完全不起作用——不像本地 transducer 那样有
`context_score` 可以调。

## 页面怎么用

1. **热词**：每行一个。英文会自动转大写（这个模型的词表只有大写英文）。可写
   `MultiCC :5` 给单条加权。
2. **参考文本**：把刚才说的话打进去，每张卡会给出 CER（错字率）和逐字对齐。
3. **热词权重**：0.5–6，越高越容易把热词塞进结果，也越容易幻觉。建议从 3 起，往下试。
4. 点「开始录音」说一句、再点停止；或者「选择音频文件」拿现成 wav 复现。
5. **在线 ASR 接口**那一行是折叠的，点开可临时改 Base URL / 模型 / Key。
   只要 `.env` 里有 key，页面启动时会自动勾上「在线 Whisper」并显示「已配置」。

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
