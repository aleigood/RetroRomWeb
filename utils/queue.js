const events = require('events');

class TaskQueue extends events.EventEmitter {
    constructor () {
        super();
        this.queue = [];
        this.processing = false;
    }

    add (task) {
        this.queue.push(task);
        this.processNext();
    }

    async processNext () {
        if (this.processing || this.queue.length === 0) return;

        this.processing = true;
        const task = this.queue.shift();

        try {
            await task();
        } catch (e) {
            console.error('任务执行出错:', e);
        } finally {
            this.processing = false;
            // 稍微延时，给 API 喘息机会
            setTimeout(() => {
                this.processNext();
            }, 1000);
        }
    }

    clear () {
        this.queue = [];
        this.processing = false;
    }

    get length () {
        return this.queue.length;
    }
}

// 导出单例
module.exports = new TaskQueue();
