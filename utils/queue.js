const events = require('events');

class TaskQueue extends events.EventEmitter {
    constructor () {
        super();
        this.normalQueue = [];
        this.expressQueue = []; // 【新增】VIP 快车道队列
        this.processing = false;
    }

    // 【修改】增加 isExpress 参数，用于判断是否插入快车道
    add (task, isExpress = false) {
        if (isExpress) {
            this.expressQueue.push(task);
            console.log(`[Queue] 🚀 VIP任务已加入，当前快车道排队: ${this.expressQueue.length}`);
        } else {
            this.normalQueue.push(task);
        }
        this.processNext();
    }

    async processNext () {
        // 如果正在处理，或者两个队列都为空，则跳过
        if (this.processing || (this.normalQueue.length === 0 && this.expressQueue.length === 0)) return;

        this.processing = true;

        // 【核心修改】优先从 expressQueue 获取任务，如果为空再从 normalQueue 获取
        let task = null;
        if (this.expressQueue.length > 0) {
            task = this.expressQueue.shift();
        } else {
            task = this.normalQueue.shift();
        }

        try {
            if (task) await task();
        } catch (e) {
            console.error('任务执行出错:', e);
        } finally {
            // 只要任何一个队列还有任务，就继续设置定时器循环
            if (this.normalQueue.length > 0 || this.expressQueue.length > 0) {
                // 稍微延时，给 API 喘息机会
                setTimeout(() => {
                    this.processing = false;
                    this.processNext();
                }, 1000);
            } else {
                this.processing = false;
            }
        }
    }

    // 【修改】清空指令需要同时清空两个队列
    clear () {
        console.log(
            `[Queue] 收到清空指令，丢弃普通任务 ${this.normalQueue.length} 个，VIP任务 ${this.expressQueue.length} 个`
        );
        this.normalQueue = [];
        this.expressQueue = [];
        this.processing = false;
    }

    get length () {
        return this.normalQueue.length + this.expressQueue.length;
    }
}

// 导出单例
module.exports = new TaskQueue();
