const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'vote-db.json');

app.use(cors());
app.use(express.json({ limit: '1mb' }));

function readDb() {
    try {
        if (!fs.existsSync(DB_FILE)) return { weeks: {} };
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        const data = JSON.parse(raw || '{}');
        return { weeks: data.weeks || {} };
    } catch (_) {
        return { weeks: {} };
    }
}

function writeDb(db) {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

// 串行写库，避免 50+ 人同时投票时并发读写导致丢票
let dbWriteChain = Promise.resolve();
function withDbLock(fn) {
    const run = dbWriteChain.then(() => fn());
    dbWriteChain = run.catch(() => {});
    return run;
}

function ensureWeek(db, weekId) {
    if (!db.weeks[weekId]) {
        db.weeks[weekId] = { config: null, votes: [] };
    }
    if (!Array.isArray(db.weeks[weekId].votes)) db.weeks[weekId].votes = [];
    return db.weeks[weekId];
}

function cleanName(str) {
    return String(str || '').replace(/[\s\u3000\r\n\t]/g, '').trim();
}

function parseStudentName(str) {
    let s = cleanName(str);
    s = s.replace(/^[\d]+[\.\、\)\]\s]+/, '');
    return s.trim();
}

function nameEquals(a, b) {
    return parseStudentName(a) === parseStudentName(b);
}

app.get('/health', (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
});

app.put('/api/weeks/:weekId', (req, res) => {
    const { weekId } = req.params;
    const payload = req.body || {};
    if (!payload.w || String(payload.w) !== String(weekId)) {
        return res.status(400).send('周次参数不一致');
    }
    if (!Array.isArray(payload.g) || payload.g.length === 0) {
        return res.status(400).send('小组数据不能为空');
    }

    withDbLock(() => {
        const db = readDb();
        const week = ensureWeek(db, weekId);
        week.config = {
            w: payload.w,
            n: payload.n || '',
            g: payload.g,
            t: payload.t || '',
            s: Array.isArray(payload.s) ? payload.s : [],
            total: Number(payload.total || 0),
            a: String(payload.a || '').trim()
        };
        writeDb(db);
    })
        .then(() => res.json({ ok: true }))
        .catch(() => res.status(500).send('保存失败，请重试'));
});

app.get('/api/weeks/:weekId', (req, res) => {
    const { weekId } = req.params;
    const db = readDb();
    const week = ensureWeek(db, weekId);
    res.json(week);
});

app.post('/api/weeks/:weekId/votes', (req, res) => {
    const { weekId } = req.params;
    const payload = req.body || {};
    const name = String(payload.name || '').trim();
    const role = payload.role === 'teacher' ? 'teacher' : 'student';
    const scores = Array.isArray(payload.scores) ? payload.scores : [];
    const time = payload.time || new Date().toLocaleString('zh-CN');

    if (!name) return res.status(400).send('姓名不能为空');
    if (!scores.length) return res.status(400).send('评分不能为空');
    if (scores.some(v => Number.isNaN(Number(v)) || Number(v) < 0 || Number(v) > 10)) {
        return res.status(400).send('分数必须在0-10之间');
    }

    withDbLock(() => {
        const db = readDb();
        const week = ensureWeek(db, weekId);
        if (!week.config) throw { status: 400, msg: '该周尚未创建，请先在管理端生成二维码' };

        const isTeacher = nameEquals(name, week.config.t);
        const isStudent = (week.config.s || []).some(n => nameEquals(n, name));
        if (!isTeacher && !isStudent) throw { status: 400, msg: '姓名不在名单中' };
        if (week.votes.some(v => nameEquals(v.name, name))) throw { status: 409, msg: '已投过票，不能重复投' };
        if (scores.length !== week.config.g.length) throw { status: 400, msg: '评分项数量不匹配' };

        week.votes.push({ name, role, scores: scores.map(Number), time });
        writeDb(db);
        return week.votes.length;
    })
        .then((count) => res.json({ ok: true, count }))
        .catch((err) => {
            if (err && err.status) return res.status(err.status).send(err.msg);
            res.status(500).send('提交失败，请稍后再试');
        });
});

app.delete('/api/weeks/:weekId/votes', (req, res) => {
    const { weekId } = req.params;
    withDbLock(() => {
        const db = readDb();
        const week = ensureWeek(db, weekId);
        week.votes = [];
        writeDb(db);
    })
        .then(() => res.json({ ok: true }))
        .catch(() => res.status(500).send('重置失败，请重试'));
});

app.listen(PORT, () => {
    console.log(`vote backend running on http://0.0.0.0:${PORT}`);
});
