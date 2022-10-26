const namespace = 'ICESTARK';

/**
 * 设置缓存
 * @param key 缓存的key
 * @param value 缓存的值
 */
export const setCache = (key: string, value: any): void => {
  if (!(window as any)[namespace]) {
    (window as any)[namespace] = {};
  }
  (window as any)[namespace][key] = value; // 设置到 window.ICESTARK身上
};

/**
 * 获取缓存
 * @param key
 */
export const getCache = (key: string): any => {
  const icestark: any = (window as any)[namespace];
  return icestark && icestark[key] ? icestark[key] : null;
};
