class AgenticQueue {
    constructor(maxSize = 20) {
        this.queue = [];
        this.isProcessing = false;
        this.maxSize = maxSize;
        this.activeUsers = new Set();
    }

    get length() {
        return this.queue.length;
    }

    /**
     * @param {Function} taskFn - The async function to execute.
     * @param {string} userId - The ID of the user requesting the task (optional but recommended for anti-spam).
     * @returns {Promise<any>}
     */
    async enqueue(taskFn, userId = null) {
        if (userId && this.activeUsers.has(userId)) {
            return Promise.reject(new Error('Anda masih memiliki antrean eksekusi yang sedang berjalan. Mohon tunggu proses sebelumnya selesai.'));
        }

        if (this.queue.length >= this.maxSize) {
            return Promise.reject(new Error('Sistem sedang melayani terlalu banyak permintaan (Beban Penuh). Mohon coba lagi dalam beberapa menit.'));
        }

        return new Promise((resolve, reject) => {
            if (userId) this.activeUsers.add(userId);

            this.queue.push(async () => {
                try {
                    const result = await taskFn();
                    resolve(result);
                } catch (e) {
                    reject(e);
                } finally {
                    if (userId) this.activeUsers.delete(userId);
                }
            });
            this.process();
        });
    }

    async process() {
        if (this.isProcessing || this.queue.length === 0) return;
        this.isProcessing = true;
        
        const task = this.queue.shift();
        try {
            await task();
        } finally {
            this.isProcessing = false;
            // Process next item in queue
            this.process();
        }
    }
}

// Global Singleton Instance
const agenticQueue = new AgenticQueue(20);

module.exports = { agenticQueue };
