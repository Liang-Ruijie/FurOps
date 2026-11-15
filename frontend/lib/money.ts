// 表单金额按十进制转换为分，不静默四舍五入。
export function yuanToFen(value: string): number {
  const text = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error('金额最多填写两位小数，请核对');
  const [whole, fraction = ''] = text.split('.');
  const fen = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (fen <= 0n || fen > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('金额必须大于0且在有效范围内');
  return Number(fen);
}
