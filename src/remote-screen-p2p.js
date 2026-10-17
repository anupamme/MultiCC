'use strict';

// 「🖥 屏幕」P2P 直连：WebRTC DataChannel（werift，纯 JS）。
//
// 信令不新开端口，走已鉴权的 /ws/remote-screen?mode=h264 上的文本消息：
//   服务端 → 浏览器  {t:'rtc-hello', iceServers}      本连接可以试直连
//   浏览器 → 服务端  {t:'rtc-offer', sdp}               浏览器发起（DataChannel 也由它建）
//   服务端 → 浏览器  {t:'rtc-answer', sdp}
//   双向            {t:'rtc-ice', candidate}            trickle ICE
//   服务端 → 浏览器  {t:'rtc-active', on}                帧改走直连 / 退回中继
// 打洞只用 STUN 探公网地址，从不经第三方转发；打不通就继续走上面这条 WS——中继只用
// 现有外网通道。帧格式与 h264.sock 相同；DataChannel 上按字节流分片发送
// （单条 SCTP 消息有大小上限，关键帧可能超过），浏览器用同一个流式解析器拼回。

// 公共 STUN（只探测地址，不转发数据）。MULTICC_REMOTE_STUN 可覆盖：逗号分隔的
// stun:/stuns: 地址；设为空串 = 不用 STUN，只在局域网直连。
const DEFAULT_STUN = ['stun:stun.miwifi.com:3478', 'stun:stun.l.google.com:19302'];

function iceServersFromEnv(env = process.env) {
  const raw = env.MULTICC_REMOTE_STUN;
  if (raw == null) return [{ urls: DEFAULT_STUN }];
  const urls = String(raw).split(',').map(s => s.trim()).filter(s => /^stuns?:[^\s]+$/.test(s)).slice(0, 4);
  return urls.length ? [{ urls }] : [];
}

let weriftMod;
function loadWerift() {
  if (weriftMod === undefined) {
    try { weriftMod = require('werift'); } catch { weriftMod = null; }
  }
  return weriftMod;
}

// MULTICC_REMOTE_P2P=0 关掉直连（只走中继）；werift 没装时同样只走中继。
function p2pAvailable(env = process.env) {
  return env.MULTICC_REMOTE_P2P !== '0' && !!loadWerift();
}

const MAX_SDP = 64 * 1024;
const MAX_CANDIDATE = 1024;

// 一条 WS 连接上的直连会话。浏览器可以多次 offer（断了重试），每次替换掉上一个 peer。
function createP2pSession({
  iceServers = [],
  sendSignal,                 // obj => void，经 WS 发文本
  onOpen,                     // sink => void，DataChannel 可用
  onClose,                    // () => void，当前直连断开
  onMessage,                  // Buffer => void，浏览器经 DataChannel 发来的输入
  werift = loadWerift(),
  openTimeoutMs = 10000,
  chunkBytes = 16 * 1024,
} = {}) {
  let pc = null;
  let channel = null;
  let generation = 0;
  let closed = false;
  let timer = null;

  const dropPeer = () => {
    clearTimeout(timer);
    timer = null;
    const old = pc, hadChannel = !!channel;
    pc = null; channel = null;
    if (old) old.close().catch(() => {});
    if (hadChannel) onClose?.();
  };

  async function handleOffer(sdp) {
    dropPeer();
    const gen = ++generation;
    // werift 等收集完才出 answer；STUN 不通时默认要等满 5 秒。给个上限：没配 STUN 1 秒、
    // 配了 2 秒（实测小米 STUN 约 0.5 秒拿到公网地址）。这段时间画面照常走中继。
    const peer = new werift.RTCPeerConnection({ iceServers, iceStunGatherTimeout: iceServers.length ? 2 : 1 });
    pc = peer;
    const live = () => !closed && gen === generation;
    peer.onIceCandidate.subscribe(c => {
      if (live() && c) sendSignal({ t: 'rtc-ice', candidate: typeof c.toJSON === 'function' ? c.toJSON() : c });
    });
    peer.connectionStateChange.subscribe(state => {
      if (live() && (state === 'failed' || state === 'closed')) dropPeer();
    });
    peer.onDataChannel.subscribe(dc => {
      if (!live() || channel) return;
      const ready = () => {
        if (!live() || channel) return;
        clearTimeout(timer);
        channel = dc;
        onOpen?.({
          kind: 'p2p',
          buffered: () => dc.bufferedAmount || 0,
          send: msg => {
            for (let off = 0; off < msg.length; off += chunkBytes) dc.send(msg.subarray(off, off + chunkBytes));
          },
        });
      };
      dc.onMessage.subscribe(data => {
        if (live() && channel === dc && Buffer.isBuffer(data)) onMessage?.(data);
      });
      dc.stateChanged.subscribe(state => {
        if (state === 'open') ready();
        else if ((state === 'closed' || state === 'closing') && live() && channel === dc) dropPeer();
      });
      if (dc.readyState === 'open') ready();
    });
    timer = setTimeout(() => { if (live() && !channel) dropPeer(); }, openTimeoutMs);
    timer.unref?.();
    await peer.setRemoteDescription({ type: 'offer', sdp });
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    if (live()) sendSignal({ t: 'rtc-answer', sdp: peer.localDescription.sdp });
  }

  function handleSignal(msg) {
    if (closed || !msg || typeof msg !== 'object') return;
    if (msg.t === 'rtc-offer') {
      if (typeof msg.sdp !== 'string' || !msg.sdp || msg.sdp.length > MAX_SDP) return;
      handleOffer(msg.sdp).catch(() => dropPeer());
    } else if (msg.t === 'rtc-ice') {
      const c = msg.candidate;
      if (!pc || !c || typeof c.candidate !== 'string' || c.candidate.length > MAX_CANDIDATE) return;
      pc.addIceCandidate({
        candidate: c.candidate,
        sdpMid: typeof c.sdpMid === 'string' ? c.sdpMid : undefined,
        sdpMLineIndex: Number.isInteger(c.sdpMLineIndex) ? c.sdpMLineIndex : undefined,
      }).catch(() => {});
    } else if (msg.t === 'rtc-close') {
      dropPeer();
    }
  }

  return {
    handleSignal,
    get active() { return !!channel; },
    close() {
      if (closed) return;
      closed = true;
      generation += 1;
      clearTimeout(timer);
      const old = pc;
      pc = null; channel = null;
      if (old) old.close().catch(() => {});
    },
  };
}

module.exports = { createP2pSession, iceServersFromEnv, p2pAvailable, loadWerift, DEFAULT_STUN };
