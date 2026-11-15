// 腾讯云录音文件识别极速版的普通引擎（FlashRecognition，16k_zh；不是一句话识别或大模型版），复用旧项目跑通的签名与格式处理。
// 只用免费额度、不足即停；未配置密钥时明确报错，前端回退文字输入。真实验证前需核对额度（待验）。
import { createHmac } from 'node:crypto';
import { AppError } from './errors.ts';

interface AsrConfig { appId: string; secretId: string; secretKey: string }

function readAsrConfig(): AsrConfig | null {
  const appId = process.env.TENCENT_ASR_APPID;
  const secretId = process.env.TENCENT_SECRET_ID;
  const secretKey = process.env.TENCENT_SECRET_KEY;
  if (!appId || !secretId || !secretKey) return null;
  return { appId, secretId, secretKey };
}

function flashRequest(config: AsrConfig, now = Date.now()) {
  const values: Record<string, string> = {
    engine_type: '16k_zh',
    secretid: config.secretId,
    timestamp: String(Math.floor(now / 1000)),
    voice_format: 'wav',
  };
  const entries = Object.entries(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const target = 'asr.cloud.tencent.com/asr/flash/v1/' + config.appId;
  const canonical = target + '?' + entries.map(([k, v]) => k + '=' + v).join('&');
  return {
    url: 'https://' + target + '?' + new URLSearchParams(entries).toString(),
    authorization: createHmac('sha1', config.secretKey).update('POST' + canonical).digest('base64'),
  };
}

// 输入 16kHz 单声道 WAV（PCM），返回转写文本
export async function transcribeWav(audio: Uint8Array): Promise<string> {
  const b=Buffer.from(audio);
  if(b.length<=44||b.toString('ascii',0,4)!=='RIFF'||b.toString('ascii',8,12)!=='WAVE'||b.toString('ascii',12,16)!=='fmt '||b.readUInt32LE(16)!==16||b.readUInt16LE(20)!==1||b.readUInt16LE(22)!==1||b.readUInt32LE(24)!==16000||b.readUInt16LE(34)!==16||b.toString('ascii',36,40)!=='data'||b.readUInt32LE(40)!==b.length-44||b.length>44+16000*60*2)throw new AppError('SCHEMA_INVALID','录音格式或时长不正确，请重新录音或输入文字',{httpStatus:400});
  const config = readAsrConfig();
  if (!config) throw new AppError('ASR_CONFIG', '语音转写尚未配置，请继续输入文字', { httpStatus: 503 });
  const request = flashRequest(config);
  const response = await fetch(request.url, {
    method: 'POST',
    headers: {
      'Host': 'asr.cloud.tencent.com',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(audio.byteLength),
      'Authorization': request.authorization,
    },
    body: Buffer.from(audio),
    signal: AbortSignal.timeout(25000),
  });
  let data: any;
  try { data = await response.json(); } catch { throw new AppError('ASR_RESPONSE', '语音服务返回格式异常，请继续输入文字', { httpStatus: 502 }); }
  if (data.code !== 0) {
    if (data.code === 4004 || data.code === 4005) throw new AppError('ASR_QUOTA', '免费语音额度不可用，已停止转写，请继续输入文字', { httpStatus: 403 });
    throw new AppError('ASR_PROVIDER', '本段语音未能转写，请继续输入文字', { httpStatus: 502 });
  }
  const text = Array.isArray(data.flash_result) ? (data.flash_result.find((v: any) => v.channel_id === 0)?.text ?? '').trim() : '';
  if (!text) throw new AppError('ASR_EMPTY', '没有识别到有效文字，请继续输入文字', { httpStatus: 422 });
  return text;
}
