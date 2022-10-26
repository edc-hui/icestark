/* eslint import/no-mutable-exports: 'off' */

import { isArray, warn } from './utils';
import { setCache, getCache } from './cache';

const eventNameSpace = 'event';

type StringSymbolUnion = string | symbol;

interface Hooks {
  emit(key: StringSymbolUnion, value: any): void;
  on(key: StringSymbolUnion, callback: (value: any) => void): void;
  off(key: StringSymbolUnion, callback?: (value: any) => void): void;
  has(key: StringSymbolUnion): boolean;
}

class Event implements Hooks {
  eventEmitter: object;

  constructor() {
    this.eventEmitter = {}; // 储存所有事件
  }

  /**
   * 根据事件名去触发事件对应的回调函数
   * @param key 事件名
   * @param args 自定义的参数
   */
  emit(key: StringSymbolUnion, ...args) {
    // 从this.eventEmitter中取出所有该事件的回调函数
    const keyEmitter = this.eventEmitter[key];

    if (!isArray(keyEmitter) || (isArray(keyEmitter) && keyEmitter.length === 0)) {
      warn(`event.emit: no callback is called for ${String(key)}`);
      return;
    }

    // 执行所有的回调，并将参数传入每一个回调中
    keyEmitter.forEach(cb => {
      cb(...args);
    });
  }

  /**
   * 注册监听事件
   * @param key 事件名
   * @param callback 响应事件回调函数
   */
  on(key: StringSymbolUnion, callback: (value: any) => void) {
    if (typeof key !== 'string' && typeof key !== 'symbol') {
      warn('event.on: key should be string / symbol');
      return;
    }
    if (callback === undefined || typeof callback !== 'function') {
      warn('event.on: callback is required, should be function');
      return;
    }

    if (!this.eventEmitter[key]) {
      this.eventEmitter[key] = []; // 开发者可能会多次监听相同事件，故此处需要使用数组来储存事件的回调函数
    }

    this.eventEmitter[key].push(callback);
  }

  /**
   * 移除注册事件的回调函数
   * @param key 事件名
   * @param callback 事件的回调函数
   */
  off(key: StringSymbolUnion, callback?: (value: any) => void) {
    if (typeof key !== 'string' && typeof key !== 'symbol') {
      warn('event.off: key should be string / symbol');
      return;

    }

    if (!isArray(this.eventEmitter[key])) {
      warn(`event.off: ${String(key)} has no callback`);
      return;
    }

    // 移除当前事件所有的回调函数
    if (callback === undefined) {
      this.eventEmitter[key] = undefined;
      return;
    }

    // 移除当前事件指定的回调函数，采用内存 堆中的引用地址是否一致作为判断条件
    this.eventEmitter[key] = this.eventEmitter[key].filter(cb => cb !== callback);
  }

  /**
   * 检测是否有事件的回调函数
   * @param key 事件名
   */
  has(key: StringSymbolUnion) {
    const keyEmitter = this.eventEmitter[key];
    return isArray(keyEmitter) && keyEmitter.length > 0;
  }
}

let event = getCache(eventNameSpace);
if (!event) {
  event = new Event();
  setCache(eventNameSpace, event);
}

export default event;
