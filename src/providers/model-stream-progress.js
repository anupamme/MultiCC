'use strict';

const { StringDecoder } = require('node:string_decoder');

// 仅模型内容、推理内容和工具参数可以续期；SSE ping、注释和状态事件不算。
function createModelStreamProgress() {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let dropping = false;
  return chunk => {
    pending += typeof chunk === 'string' ? chunk : decoder.write(Buffer.from(chunk));
    let progress = false;
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(pending))) {
      const frame = pending.slice(0, boundary.index);
      pending = pending.slice(boundary.index + boundary[0].length);
      if (dropping) { dropping = false; continue; }
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart()).join('\n');
      try {
        const event = JSON.parse(data);
        const type = String(event.type || '');
        const delta = event.delta;
        if (type === 'content_block_delta' && delta &&
            ['text', 'thinking', 'partial_json', 'signature'].some(key => typeof delta[key] === 'string' && delta[key].length)) progress = true;
        if (/^response\..*\.delta$/.test(type) && typeof delta === 'string' && delta.length) progress = true;
        if (type === 'content_block_start' && event.content_block &&
            ['text', 'thinking'].some(key => event.content_block[key]?.length)) progress = true;
        if (type === 'content_block_start' && event.content_block?.type === 'tool_use') progress = true;
        if (type === 'response.output_item.added' && /(?:function|custom_tool)_call/.test(event.item?.type || '')) progress = true;
      } catch (_) { /* 不完整、未知、保活事件不能证明模型进展。 */ }
    }
    if (pending.length > 262_144) { pending = ''; dropping = true; }
    return progress;
  };
}

module.exports = { createModelStreamProgress };
