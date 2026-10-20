# 本地语音识别对比台（scripts/asr-compare）

同一个页面、同一段录音，把 SenseVoiceSmall 与几个流式 Zipformer transducer 并排跑一遍，
自己听、自己看、自己算错字率。用来回答一个具体问题：**默认本地模型该不该换。**

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

## 页面怎么用

1. **热词**：每行一个。英文会自动转大写（这个模型的词表只有大写英文）。可写
   `MultiCC :5` 给单条加权。
2. **参考文本**：把刚才说的话打进去，每张卡会给出 CER（错字率）和逐字对齐。
3. **热词权重**：0.5–6，越高越容易把热词塞进结果，也越容易幻觉。建议从 3 起，往下试。
4. 点「开始录音」说一句、再点停止；或者「选择音频文件」拿现成 wav 复现。

## 引擎与实测（2026-10-20，6 句 TTS 基准）

| 引擎 | 体积 | 平均 CER | 备注 |
|---|---|---|---|
| SenseVoiceSmall int8（现状默认） | 239MB | **0.098** | 离线，无解码期热词 |
| Zipformer 双语 2023-02-20 | 198MB | 0.341 | 复读缺陷；英文全大写 |
| Zipformer 中文 2025-06-30 | 167MB | 0.207–0.217 | 词表无 ASCII，读不了英文 |
| Zipformer 多语种 2025-02-10 | 339MB | 0.247–0.255 | 中文最差 |

解码期热词的行为（在页面上可直接复现）：

- 中文热词有效，能把丢掉的尾字补回来（`…聊天记` → `…聊天记录`，context_score 3）。
- 英文热词**必须大写**才编码得进词表；`ALSO COMMIT` → `ALSO AUTOCOMMIT` 能修对。
- 但 `MULTICC` / `WORKTREE` 这类词仍然修不对，权重拉到 3 以上还会往句子里插噪声。
- 权重的代价：分数越高，幻觉越多；`context_score` 只说明命中，不说明命中对了。

## 内存

每个在线 recognizer 常驻 200–500MB。五个引擎全开约 1.5GB；默认三档（sense / bi / bi-hw）
约 800MB。缓存上限 6 个，超出的按 LRU 淘汰。
