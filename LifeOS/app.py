from flask import Flask, render_template, request, jsonify, Response
from pathlib import Path
from datetime import date, datetime, timedelta
import sqlite3
import csv
import io

app = Flask(__name__)
DB_PATH = Path(__file__).with_name("lifeos.db")


def connect_db():
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    return db


def table_columns(db, table):
    return {row["name"] for row in db.execute(f"PRAGMA table_info({table})")}


def init_db():
    with connect_db() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT 'Personal',
            due_date TEXT,
            completed INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS goals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            completed INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS habits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT '#9b87ff',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            active INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS habit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            habit_id INTEGER NOT NULL,
            log_date TEXT NOT NULL,
            UNIQUE(habit_id, log_date),
            FOREIGN KEY(habit_id) REFERENCES habits(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS focus_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mode TEXT NOT NULL DEFAULT 'focus',
            duration_minutes INTEGER NOT NULL,
            completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        """)
        # Add columns to an older LifeOS tasks table without dropping its data.
        existing = table_columns(db, "tasks")
        status_was_missing = "status" not in existing
        for name, definition in {
            "status": "TEXT NOT NULL DEFAULT 'todo'",
            "priority": "TEXT NOT NULL DEFAULT 'Medium'",
            "updated_at": "TEXT"
        }.items():
            if name not in existing:
                db.execute(f"ALTER TABLE tasks ADD COLUMN {name} {definition}")
        # If this is the original LifeOS schema, infer Kanban status from its
        # old completed flag. Do this even though SQLite fills new columns with
        # their DEFAULT value for existing rows.
        if status_was_missing:
            db.execute("UPDATE tasks SET status = CASE WHEN completed = 1 THEN 'done' ELSE 'todo' END")
        else:
            db.execute("UPDATE tasks SET status = CASE WHEN status IS NULL OR status = '' THEN CASE WHEN completed = 1 THEN 'done' ELSE 'todo' END ELSE status END")
        db.execute("UPDATE tasks SET updated_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP)")
        # Keep the legacy completed flag and the new Kanban status synchronized.
        db.execute("UPDATE tasks SET completed = CASE WHEN status = 'done' THEN 1 ELSE 0 END")


def payload():
    return request.get_json(silent=True) or {}


def clean_title(value, label="Title"):
    value = str(value or "").strip()
    if not value:
        return None, f"{label} is required."
    if len(value) > 150:
        return None, f"{label} must be 150 characters or fewer."
    return value, None


def task_json(row):
    item = dict(row)
    item["completed"] = int(item.get("completed", 0) or 0)
    item["status"] = item.get("status") or ("done" if item["completed"] else "todo")
    item["priority"] = item.get("priority") or "Medium"
    return item


def current_streak(db, habit_id):
    days = {r["log_date"] for r in db.execute(
        "SELECT log_date FROM habit_logs WHERE habit_id = ?", (habit_id,))}
    cursor, streak = date.today(), 0
    # Allow the streak to continue if the habit was completed today or yesterday.
    if cursor.isoformat() not in days:
        cursor -= timedelta(days=1)
    while cursor.isoformat() in days:
        streak += 1
        cursor -= timedelta(days=1)
    return streak


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/data")
def get_data():
    today = date.today()
    with connect_db() as db:
        tasks = [task_json(r) for r in db.execute("SELECT * FROM tasks ORDER BY id DESC")]
        goals = [dict(r) for r in db.execute("SELECT * FROM goals ORDER BY id DESC")]
        habits = [dict(r) for r in db.execute("SELECT * FROM habits WHERE active = 1 ORDER BY id DESC")]
        for h in habits:
            h["done_today"] = bool(db.execute(
                "SELECT 1 FROM habit_logs WHERE habit_id=? AND log_date=?", (h["id"], today.isoformat())).fetchone())
            h["streak"] = current_streak(db, h["id"])
            h["week"] = [bool(db.execute(
                "SELECT 1 FROM habit_logs WHERE habit_id=? AND log_date=?",
                (h["id"], (today - timedelta(days=6-i)).isoformat())).fetchone()) for i in range(7)]
        weekly = []
        for offset in range(6, -1, -1):
            day = today - timedelta(days=offset)
            completed = db.execute("SELECT COUNT(*) n FROM tasks WHERE completed=1 AND date(updated_at)=?", (day.isoformat(),)).fetchone()["n"]
            focus = db.execute("SELECT COALESCE(SUM(duration_minutes),0) n FROM focus_sessions WHERE mode='focus' AND date(completed_at)=?", (day.isoformat(),)).fetchone()["n"]
            weekly.append({"date": day.isoformat(), "label": day.strftime("%a"), "tasks": completed, "focus": focus})
        focus_today = db.execute("SELECT COALESCE(SUM(duration_minutes),0) n FROM focus_sessions WHERE mode='focus' AND date(completed_at)=?", (today.isoformat(),)).fetchone()["n"]
        total_focus = db.execute("SELECT COUNT(*) n FROM focus_sessions WHERE mode='focus'").fetchone()["n"]
    done = sum(t["status"] == "done" for t in tasks)
    progress = sum(t["status"] == "progress" for t in tasks)
    return jsonify({
        "tasks": tasks, "goals": goals, "habits": habits, "weekly": weekly, "today": today.isoformat(),
        "stats": {"total_tasks": len(tasks), "completed_tasks": done, "in_progress": progress,
                  "pending_tasks": len(tasks)-done, "task_progress": round(done/len(tasks)*100) if tasks else 0,
                  "habits_done": sum(h["done_today"] for h in habits), "habits_total": len(habits),
                  "focus_minutes": focus_today, "focus_sessions": total_focus}
    })


@app.post("/api/tasks")
def create_task():
    data = payload()
    title, issue = clean_title(data.get("title"), "Task title")
    if issue: return jsonify(error=issue), 400
    category = data.get("category", "Personal")
    if category not in {"Study", "Work", "Personal", "Health", "Other"}: category = "Personal"
    priority = data.get("priority", "Medium")
    if priority not in {"Low", "Medium", "High", "Urgent"}: priority = "Medium"
    status = data.get("status", "todo")
    if status not in {"todo", "progress", "done"}: status = "todo"
    due = (data.get("due_date") or "").strip() or None
    if due:
        try: datetime.strptime(due, "%Y-%m-%d")
        except ValueError: return jsonify(error="Please use a valid due date."), 400
    with connect_db() as db:
        cur = db.execute("""INSERT INTO tasks(title,category,due_date,completed,status,priority,updated_at)
            VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP)""", (title, category, due, int(status == "done"), status, priority))
        new_id = cur.lastrowid
    return jsonify(id=new_id), 201


@app.patch("/api/tasks/<int:task_id>")
def update_task(task_id):
    data = payload()
    allowed = {"title", "category", "due_date", "status", "priority"}
    changes = {k: data[k] for k in allowed if k in data}
    if not changes: return jsonify(error="No changes provided."), 400
    if "title" in changes:
        title, issue = clean_title(changes["title"], "Task title")
        if issue: return jsonify(error=issue), 400
        changes["title"] = title
    if "category" in changes and changes["category"] not in {"Study", "Work", "Personal", "Health", "Other"}:
        return jsonify(error="Invalid category."), 400
    if "priority" in changes and changes["priority"] not in {"Low", "Medium", "High", "Urgent"}:
        return jsonify(error="Invalid priority."), 400
    if "status" in changes:
        if changes["status"] not in {"todo", "progress", "done"}: return jsonify(error="Invalid status."), 400
        changes["completed"] = int(changes["status"] == "done")
    if "due_date" in changes:
        due = str(changes["due_date"] or "").strip() or None
        if due:
            try: datetime.strptime(due, "%Y-%m-%d")
            except ValueError: return jsonify(error="Please use a valid due date."), 400
        changes["due_date"] = due
    assignments = ", ".join(f"{key}=?" for key in changes)
    with connect_db() as db:
        cur = db.execute(f"UPDATE tasks SET {assignments}, updated_at=CURRENT_TIMESTAMP WHERE id=?", (*changes.values(), task_id))
        if not cur.rowcount: return jsonify(error="Task not found."), 404
    return jsonify(message="Task updated")


@app.delete("/api/tasks/<int:task_id>")
def remove_task(task_id):
    with connect_db() as db:
        cur = db.execute("DELETE FROM tasks WHERE id=?", (task_id,))
        if not cur.rowcount: return jsonify(error="Task not found."), 404
    return jsonify(message="Task deleted")


@app.post("/api/goals")
def create_goal():
    title, issue = clean_title(payload().get("title"), "Goal")
    if issue: return jsonify(error=issue), 400
    with connect_db() as db:
        cur = db.execute("INSERT INTO goals(title) VALUES(?)", (title,))
    return jsonify(id=cur.lastrowid), 201


@app.patch("/api/goals/<int:goal_id>")
def change_goal(goal_id):
    with connect_db() as db:
        row = db.execute("SELECT completed FROM goals WHERE id=?", (goal_id,)).fetchone()
        if not row: return jsonify(error="Goal not found."), 404
        db.execute("UPDATE goals SET completed=? WHERE id=?", (1-int(row["completed"]), goal_id))
    return jsonify(message="Goal updated")


@app.delete("/api/goals/<int:goal_id>")
def remove_goal(goal_id):
    with connect_db() as db:
        cur = db.execute("DELETE FROM goals WHERE id=?", (goal_id,))
        if not cur.rowcount: return jsonify(error="Goal not found."), 404
    return jsonify(message="Goal deleted")


@app.post("/api/habits")
def create_habit():
    title, issue = clean_title(payload().get("title"), "Habit")
    if issue: return jsonify(error=issue), 400
    with connect_db() as db:
        cur = db.execute("INSERT INTO habits(title) VALUES(?)", (title,))
    return jsonify(id=cur.lastrowid), 201


@app.post("/api/habits/<int:habit_id>/check")
def toggle_habit(habit_id):
    today = date.today().isoformat()
    with connect_db() as db:
        if not db.execute("SELECT id FROM habits WHERE id=? AND active=1", (habit_id,)).fetchone():
            return jsonify(error="Habit not found."), 404
        row = db.execute("SELECT id FROM habit_logs WHERE habit_id=? AND log_date=?", (habit_id, today)).fetchone()
        if row:
            db.execute("DELETE FROM habit_logs WHERE id=?", (row["id"],)); done = False
        else:
            db.execute("INSERT INTO habit_logs(habit_id,log_date) VALUES(?,?)", (habit_id, today)); done = True
    return jsonify(done_today=done)


@app.delete("/api/habits/<int:habit_id>")
def remove_habit(habit_id):
    with connect_db() as db:
        cur = db.execute("DELETE FROM habits WHERE id=?", (habit_id,))
        if not cur.rowcount: return jsonify(error="Habit not found."), 404
    return jsonify(message="Habit deleted")


@app.post("/api/focus")
def save_focus():
    data = payload()
    mode = data.get("mode", "focus")
    try: minutes = int(data.get("minutes", 25))
    except (TypeError, ValueError): return jsonify(error="Invalid duration."), 400
    if mode not in {"focus", "break"} or not 1 <= minutes <= 180:
        return jsonify(error="Duration must be between 1 and 180 minutes."), 400
    with connect_db() as db:
        cur = db.execute("INSERT INTO focus_sessions(mode,duration_minutes) VALUES(?,?)", (mode, minutes))
    return jsonify(id=cur.lastrowid), 201


@app.get("/api/export")
def export_csv():
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["ID", "Title", "Category", "Priority", "Status", "Due date", "Created"])
    with connect_db() as db:
        writer.writerows(db.execute("SELECT id,title,category,priority,status,due_date,created_at FROM tasks ORDER BY id"))
    return Response("\ufeff" + output.getvalue(), mimetype="text/csv; charset=utf-8",
                    headers={"Content-Disposition": "attachment; filename=lifeos_tasks.csv"})


init_db()

if __name__ == "__main__":
    app.run(debug=True)
