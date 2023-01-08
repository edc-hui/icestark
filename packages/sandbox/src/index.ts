export interface SandboxProps {
  multiMode?: boolean;
}

export interface SandboxConstructor {
  new(): Sandbox;
}

// check window constructor function， like Object Array
function isConstructor(fn) {
  // generator function and has own prototype properties
  const hasConstructor = fn.prototype && fn.prototype.constructor === fn && Object.getOwnPropertyNames(fn.prototype).length > 1;
  // unnecessary to call toString if it has constructor function
  const functionStr = !hasConstructor && fn.toString();
  const upperCaseRegex = /^function\s+[A-Z]/;

  return (
    hasConstructor ||
    // upper case
    upperCaseRegex.test(functionStr) ||
    // ES6 class, window function do not have this case
    functionStr.slice(0, 5) === 'class'
  );
}

// get function from original window, such as scrollTo, parseInt
function isWindowFunction(func) {
  return func && typeof func === 'function' && !isConstructor(func);
}

export default class Sandbox {
  private sandbox: Window;

  private multiMode = false; // 是否启用多模式

  private eventListeners = {}; // 记录监听的事件

  private timeoutIds: number[] = []; // 记录定时器的id

  private intervalIds: number[] = []; // 记录

  private propertyAdded = {}; // 记录添加的原始window对象身上没有的属性

  private originalValues = {}; // 原始window对象身上有的属性，记录下在更改其属性值之前的属性以及属性值

  public sandboxDisabled: boolean; // 记录是否禁用沙箱

  constructor(props: SandboxProps = {}) {
    const { multiMode } = props;
    if (!window.Proxy) {
      console.warn('proxy sandbox is not support by current browser');
      this.sandboxDisabled = true; // 浏览器不支持Proxy，则将sandboxDisabled置为true
    }
    // enable multiMode in case of create mulit sandbox in same time
    this.multiMode = multiMode; // 是否启用多模式沙箱
    this.sandbox = null; // 储存沙箱的代理
  }

  /**
   * 创建Proxy沙箱
   * @param injection
   */
  createProxySandbox(injection?: object) {
    const { propertyAdded, originalValues, multiMode } = this;
    const proxyWindow = Object.create(null) as Window; // 创建一个干净且高度可定制的对象
    const originalWindow = window; // 缓存原始window对象
    const originalAddEventListener = window.addEventListener; // 缓存原始addEventListener事件绑定函数
    const originalRemoveEventListener = window.removeEventListener;// 缓存原始removeEventListener事件移除函数
    const originalSetInterval = window.setInterval; // 缓存原始定时器setInterval函数
    const originalSetTimeout = window.setTimeout; // 缓存原始定时器setTimeout函数

    // 劫持 addEventListener，将绑定的事件名以及事件的回调函数全部储存在this.eventListeners中
    proxyWindow.addEventListener = (eventName, fn, ...rest) => {
      this.eventListeners[eventName] = (this.eventListeners[eventName] || []);
      this.eventListeners[eventName].push(fn);

      return originalAddEventListener.apply(originalWindow, [eventName, fn, ...rest]);
    };
    // 劫持 removeEventListener， 将解绑的事件名以及事件的回调函数从this.eventListeners中移除掉
    proxyWindow.removeEventListener = (eventName, fn, ...rest) => {
      const listeners = this.eventListeners[eventName] || [];
      if (listeners.includes(fn)) {
        listeners.splice(listeners.indexOf(fn), 1);
      }
      return originalRemoveEventListener.apply(originalWindow, [eventName, fn, ...rest]);
    };
    // 劫持 setTimeout，将每一个定时器的id储存在this.timeoutIds
    proxyWindow.setTimeout = (...args) => {
      const timerId = originalSetTimeout(...args);
      this.timeoutIds.push(timerId); // 存储timerId
      return timerId;
    };
    // 劫持 setInterval，将每一个定时器的id储存在this.intervalIds
    proxyWindow.setInterval = (...args) => {
      const intervalId = originalSetInterval(...args);
      this.intervalIds.push(intervalId); // 存储intervalId
      return intervalId;
    };

    // 创建Proxy，代理proxyWindow
    const sandbox = new Proxy(proxyWindow, {
      /**
       * 设置属性以及属性值
       * @param target 代理的对象 proxyWindow
       * @param p 属性名
       * @param value 属性值
       */
      set(target: Window, p: PropertyKey, value: any): boolean {
        // eslint-disable-next-line no-prototype-builtins
        if (!originalWindow.hasOwnProperty(p)) { // 说明原始window对象身上没有该属性
          // record value added in sandbox
          propertyAdded[p] = value; // 将该属性以及属性值记录在propertyAdded变量中
        // eslint-disable-next-line no-prototype-builtins
        } else if (!originalValues.hasOwnProperty(p)) { // 说明原始window对象身上有该属性, 需要在originalValues中记录下本次设置的属性以及属性值
          // if it is already been setted in original window, record it's original value
          originalValues[p] = originalWindow[p];
        }
        // set new value to original window in case of jsonp, js bundle which will be execute outof sandbox
        if (!multiMode) {
          originalWindow[p] = value; // 将window对象身上没有的属性设置到window对象身上
        }
        // eslint-disable-next-line no-param-reassign
        target[p] = value; // 设置属性以及属性值到代理的对象身上
        return true;
      },
      /**
       * 获取代理对象身上的属性值
       * @param target 代理的对象 proxyWindow
       * @param p 属性名
       */
      get(target: Window, p: PropertyKey): any {
        // Symbol.unscopables 介绍 https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Global_Objects/Symbol/unscopables
        if (p === Symbol.unscopables) {
          return undefined;
        }
        if (['top', 'window', 'self', 'globalThis'].includes(p as string)) {
          return sandbox;
        }
        // proxy hasOwnProperty, in case of proxy.hasOwnProperty value represented as originalWindow.hasOwnProperty
        if (p === 'hasOwnProperty') {
          // eslint-disable-next-line no-prototype-builtins
          return (key: PropertyKey) => !!target[key] || originalWindow.hasOwnProperty(key);
        }

        const targetValue = target[p];
        /**
         * Falsy value like 0/ ''/ false should be trapped by proxy window.
         */
        if (targetValue !== undefined) {
          // case of addEventListener, removeEventListener, setTimeout, setInterval setted in sandbox
          return targetValue;
        }

        // search from injection
        const injectionValue = injection && injection[p];
        if (injectionValue) {
          return injectionValue;
        }

        const value = originalWindow[p];

        /**
        * use `eval` indirectly if you bind it. And if eval code is not being evaluated by a direct call,
        * then initialise the execution context as if it was a global execution context.
        * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/eval
        * https://262.ecma-international.org/5.1/#sec-10.4.2
        */
        if (p === 'eval') {
          return value;
        }

        if (isWindowFunction(value)) { // 判断是不是window对象身上的函数
          // When run into some window's functions, such as `console.table`,
          // an illegal invocation exception is thrown.
          const boundValue = value.bind(originalWindow); // 更改this指向为原始window对象

          // Axios, Moment, and other callable functions may have additional properties.
          // Simply copy them into boundValue.
          for (const key in value) {
            boundValue[key] = value[key];
          }

          return boundValue;
        } else {
          // case of window.clientWidth、new window.Object()
          return value;
        }
      },
      /**
       * 用于判断代理对象身上是否有指定的属性
       * @param target 代理对象
       * @param p 属性的key
       */
      has(target: Window, p: PropertyKey): boolean {
        return p in target || p in originalWindow;
      },
    });
    this.sandbox = sandbox;
  }

  /**
   * 获取沙箱
   */
  getSandbox() {
    return this.sandbox;
  }

  /**
   * 获取已经添加的属性
   */
  getAddedProperties() {
    return this.propertyAdded;
  }

  /**
   * 执行沙箱里面的js代码
   * @param script
   */
  execScriptInSandbox(script: string): void {
    if (!this.sandboxDisabled) {
      // create sandbox before exec script
      if (!this.sandbox) {
        this.createProxySandbox();
      }
      try {
        // with 语句中  执行的js，在访问变量的时候都会先从sandbox对象身上找
        const execScript = `with (sandbox) {;${script}\n}`; // 要执行的js代码
        // eslint-disable-next-line no-new-func
        // 创建一个sandbox作为参数的函数
        const code = new Function('sandbox', execScript).bind(this.sandbox);
        // 将this.sandbox作为参数传入函数内部
        code(this.sandbox);
      } catch (error) {
        console.error(`error occurs when execute script in sandbox: ${error}`);
        throw error;
      }
    }
  }

  /**
   * 清空沙箱
   */
  clear() {
    if (!this.sandboxDisabled) {
      // remove event listeners
      Object.keys(this.eventListeners).forEach((eventName) => {
        (this.eventListeners[eventName] || []).forEach((listener) => {
          window.removeEventListener(eventName, listener);
        });
      });
      // clear timeout
      this.timeoutIds.forEach((id) => window.clearTimeout(id));
      this.intervalIds.forEach((id) => window.clearInterval(id));
      // recover original values
      Object.keys(this.originalValues).forEach((key) => {
        window[key] = this.originalValues[key];
      });
      Object.keys(this.propertyAdded).forEach((key) => {
        delete window[key];
      });
    }
  }
}
