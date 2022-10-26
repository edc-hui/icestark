/* eslint no-underscore-dangle: ["error", { "allow": ["foo_", "_bar"], "allowAfterThis": true }] */
/* eslint import/no-mutable-exports: 'off' */

import { isObject, isArray, warn } from './utils';
import { setCache, getCache } from './cache';

const storeNameSpace = 'store';

type StringSymbolUnion = string | symbol;

interface IO {
  set(key: string | symbol | object, value?: any): void;
  get(key?: StringSymbolUnion): void;
}

interface Hooks {
  on(key: StringSymbolUnion, callback: (value: any) => void, force?: boolean): void;
  off(key: StringSymbolUnion, callback?: (value: any) => void): void;
  has(key: StringSymbolUnion): boolean;
}

/**
 * Store 类，有set，get，on，off，has方法的类
 */
class Store implements IO, Hooks {
  store: object; // 存储state的变量

  storeEmitter: object; // 储存store变化的触发者

  constructor() {
    this.store = {};
    this.storeEmitter = {};
  }

  /**
   * 获取store中指定的state
   * @param key state的key
   */
  _getValue(key: StringSymbolUnion) {
    return this.store[key];
  }

  /**
   * 真正的设置state的方法
   * @param key
   * @param value
   */
  _setValue(key: StringSymbolUnion, value: any) {
    this.store[key] = value; // 设置state
    this._emit(key); // 触发state值变化事件
  }

  /**
   * 根据state的key去触发对应值变化事件
   * @param key state的key
   */
  _emit(key: StringSymbolUnion) {
    const keyEmitter = this.storeEmitter[key]; // 获取到监听该state的所有值变化回调函数

    if (!isArray(keyEmitter) || (isArray(keyEmitter) && keyEmitter.length === 0)) {
      return;
    }

    // 获取到state的值 循环执行监听state值变化回调函数
    const value = this._getValue(key);
    keyEmitter.forEach(cb => {
      cb(value);
    });
  }

  /**
   * 获取store中存储的state
   * @param key state的key
   */
  get(key?: StringSymbolUnion) {
    if (key === undefined) {
      return this.store; // 将store中存储的所有state全部返回
    }

    if (typeof key !== 'string' && typeof key !== 'symbol') {
      warn('store.get: key should be string / symbol');
      return null;
    }

    return this._getValue(key);
  }

  /**
   * 设置state的方法
   * @param key state的key
   * @param value state的value
   */
  set<T>(key: string | symbol | object, value?: T) {
    if (typeof key !== 'string'
      && typeof key !== 'symbol'
      && !isObject(key)) {
      warn('store.set: key should be string / symbol / object');
      return;
    }

    if (isObject(key)) { // 说明是一组state，遍历拿到每一个state，然后去设置到 this.store 中
      Object.keys(key).forEach(k => {
        const v = key[k];

        this._setValue(k, v);
      });
    }
    else { // 说明是一个state，直接调用_setValue设置到 this.store 中
      this._setValue(key as StringSymbolUnion, value);
    }
  }

  /**
   * 监听state值变化事件
   * @param key state的key
   * @param callback state值变化的回调函数
   * @param force 初始化注册过程中是否强制执行
   */
  on(key: StringSymbolUnion, callback: (value: any) => void, force?: boolean) {
    if (typeof key !== 'string' && typeof key !== 'symbol') {
      warn('store.on: key should be string / symbol');
      return;
    }

    if (callback === undefined || typeof callback !== 'function') {
      warn('store.on: callback is required, should be function');
      return;
    }

    if (!this.storeEmitter[key]) {
      this.storeEmitter[key] = [];
    }

    this.storeEmitter[key].push(callback);

    if (force) {
      callback(this._getValue(key)); // 将state的value作为值变化回调函数的参数
    }
  }

  /**
   * 移除监听的state值变化事件
   * @param key state的key
   * @param callback 监听的回调函数
   */
  off(key: StringSymbolUnion, callback?: (value: any) => void) {
    if (typeof key !== 'string' && typeof key !== 'symbol') {
      warn('store.off: key should be string / symbol');
      return;
    }

    if (!isArray(this.storeEmitter[key])) {
      warn(`store.off: ${String(key)} has no callback`);
      return;
    }
    // 说明要移除所有该state的回调函数
    if (callback === undefined) {
      this.storeEmitter[key] = undefined;
      return;
    }
    // 说明只移除指定的回调函数，根据回调函数在内存堆中的引用地址来进行比较
    this.storeEmitter[key] = this.storeEmitter[key].filter(cb => cb !== callback);
  }

  /**
   * 检测是否有值变化的回调函数
   * @param key state的key
   */
  has(key: StringSymbolUnion) {
    const keyEmitter = this.storeEmitter[key];
    return isArray(keyEmitter) && keyEmitter.length > 0;
  }
}

let store = getCache(storeNameSpace);
if (!store) {
  store = new Store();
  setCache(storeNameSpace, store);
}

export default store;
