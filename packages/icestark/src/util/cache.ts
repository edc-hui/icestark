const namespace = 'ICESTARK'; // 命名空间

/**
 * 设置缓存
 * @param key
 * @param value
 */
export const setCache = (key: string, value: any): void => {
  if (!(window as any)[namespace]) {
    (window as any)[namespace] = {};
  }
  (window as any)[namespace][key] = value;
};

/**
 * 从缓存中读取数据
 * @param key
 */
export const getCache = (key: string): any => {
  const icestark: any = (window as any)[namespace];
  return icestark && icestark[key] ? icestark[key] : null;
};
