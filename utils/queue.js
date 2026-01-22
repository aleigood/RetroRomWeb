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
        // 如果正在处理或队列为空，则跳过
        if (this.processing || this.queue.length === 0) return;

        this.processing = true;
        const task = this.queue.shift();

        try {
            if (task) await task();
        } catch (e) {
            console.error('任务执行出错:', e);
        } finally {
            // 【关键修改】只有当队列里还有任务时，才继续设置定时器
            // 这样一旦调用 clear() 清空了队列，循环就会自然停止
            if (this.queue.length > 0) {
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

    // 【新增】强制清空队列，用于立即中止同步
    clear () {
        console.log(`[Queue] 收到清空指令，丢弃剩余 ${this.queue.length} 个任务`);
        this.queue = [];
        this.processing = false;
    }

    get length () {
        return this.queue.length;
    }
}

// 导出单例
module.exports = new TaskQueue();
