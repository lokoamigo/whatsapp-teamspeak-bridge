'use strict';

// Keep duplicate suppression bounded without expiring the current call's ID
// merely because a call has been connected for a long time.
class RecentSet extends Set {
    constructor(limit) {
        super();
        this.limit = limit;
    }

    add(value) {
        this.delete(value);
        super.add(value);
        if (this.size > this.limit) this.delete(this.values().next().value);
        return this;
    }
}

module.exports = { RecentSet };
