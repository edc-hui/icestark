export const PREFIX = 'icestark'; // 微前端的前缀

export const DYNAMIC = 'dynamic'; // 子应用的标识

export const STATIC = 'static'; // 主应用的标识

export const ICESTSRK_NOT_FOUND = `/${PREFIX}_404`;

export const ICESTSRK_ERROR = `/${PREFIX}_error`;

export const IS_CSS_REGEX = /\.css(\?((?!\.js$).)+)?$/;

// 子应用的状态

export const NOT_LOADED = 'NOT_LOADED'; // 未加载

export const LOADING_ASSETS = 'LOADING_ASSETS'; // 正在加载资源中

export const LOAD_ERROR = 'LOAD_ERROR'; // 加载错误

export const NOT_MOUNTED = 'NOT_MOUNTED'; // 未挂载

export const MOUNTED = 'MOUNTED'; // 已挂载

export const UNMOUNTED = 'UNMOUNTED'; // 已卸载
