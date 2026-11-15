// 前端：把浏览器录音转成 16kHz 单声道 WAV（复用旧项目跑通的格式；PCM WAV 用于传输，不信任浏览器容器标签）
export function encodeMonoWav(samples: Float32Array, rate = 16000): Uint8Array {
  if (rate !== 16000 || !samples.length || samples.length > 16000 * 60) throw new Error('录音须在 60 秒以内');
  const out = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(out);
  const text = (offset: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); v.setUint32(4, out.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); text(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const x = Number.isFinite(samples[i]) ? Math.max(-1, Math.min(1, samples[i])) : 0;
    v.setInt16(44 + i * 2, Math.round(x * (x < 0 ? 32768 : 32767)), true);
  }
  return new Uint8Array(out);
}

export async function recordingWav(blob: Blob): Promise<Uint8Array> {
  if (!blob.size || blob.size > 10 * 1024 * 1024) throw new Error('录音为空或过大');
  const w = window as unknown as { OfflineAudioContext?: typeof OfflineAudioContext; webkitOfflineAudioContext?: typeof OfflineAudioContext };
  const AC = w.OfflineAudioContext ?? w.webkitOfflineAudioContext;
  if (!AC) throw new Error('浏览器不支持音频处理');
  const decoder = new AC(1, 1, 16000);
  const decoded = await decoder.decodeAudioData(await blob.arrayBuffer());
  if (!Number.isFinite(decoded.duration) || decoded.duration <= 0 || decoded.duration > 60) throw new Error('录音须在 60 秒以内');
  const context = new AC(1, Math.ceil(decoded.duration * 16000), 16000);
  const source = context.createBufferSource();
  source.buffer = decoded; source.connect(context.destination); source.start();
  const rendered = await context.startRendering();
  return encodeMonoWav(rendered.getChannelData(0));
}

// 转写：上传 WAV → 后端腾讯云普通版 ASR → 文本（失败抛错，由调用方回退文字输入）
export async function transcribe(blob: Blob): Promise<string> {
  const wav = await recordingWav(blob);
  const r = await fetch('/api/v1/asr', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: new Blob([wav as BlobPart], { type: 'audio/wav' }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || '语音转写失败，请直接输入文字');
  if(typeof j.text!=='string'||!j.text.trim())throw new Error('没有识别到清晰的文字，请重试或直接输入');
  return j.text.trim();
}
