import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import "./styles.css";

type MasterKind = "category" | "assignee" | "status" | "priority";

type MasterItem = {
  id: string;
  kind: MasterKind;
  name: string;
  color: string;
  sortOrder: number;
  enabled: boolean;
};

type Task = {
  id: string;
  name: string;
  categoryId: string;
  assigneeIds: string[];
  statusId: string;
  priorityId: string;
  startDate: string;
  dueDate: string;
  dependencyTaskIds: string[];
  notes: string;
  createdAt: string;
  updatedAt: string;
};

type LockState = {
  owner: string;
  machine: string;
  acquiredAt: string;
  token?: string | null;
};

type AppData = {
  databasePath: string;
  tasks: Task[];
  masters: MasterItem[];
  lockState?: LockState | null;
};

type ImportReport = {
  importedTasks: number;
  importedMasters: number;
  errors: string[];
};

const blankTask = (): Task => ({
  id: "",
  name: "",
  categoryId: "",
  assigneeIds: [],
  statusId: "",
  priorityId: "",
  startDate: new Date().toISOString().slice(0, 10),
  dueDate: new Date().toISOString().slice(0, 10),
  dependencyTaskIds: [],
  notes: "",
  createdAt: "",
  updatedAt: ""
});

const kindLabels: Record<MasterKind, string> = {
  category: "カテゴリ",
  assignee: "担当者",
  status: "ステータス",
  priority: "優先度"
};

function App() {
  const [data, setData] = useState<AppData | null>(null);
  const [activeTab, setActiveTab] = useState<"tasks" | "settings">("tasks");
  const [editingTask, setEditingTask] = useState<Task>(blankTask());
  const [editingMaster, setEditingMaster] = useState<MasterItem>({
    id: "",
    kind: "category",
    name: "",
    color: "#64748b",
    sortOrder: 100,
    enabled: true
  });
  const [owner, setOwner] = useState(localStorage.getItem("team-mgt-owner") || "");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [excelPath, setExcelPath] = useState("");
  const [message, setMessage] = useState("");
  const [isEditing, setIsEditing] = useState(false);

  const masters = data?.masters ?? [];
  const tasks = data?.tasks ?? [];
  const canEdit = isEditing && !data?.lockState?.token;

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (data?.databasePath) {
      setPathInput(data.databasePath);
    }
  }, [data?.databasePath]);

  const byKind = (kind: MasterKind) =>
    masters.filter((item) => item.kind === kind && item.enabled).sort((a, b) => a.sortOrder - b.sortOrder);

  const masterName = (id: string) => masters.find((item) => item.id === id)?.name ?? id;

  const filteredTasks = useMemo(() => {
    const lowerQuery = query.trim().toLowerCase();
    return tasks.filter((task) => {
      const haystack = [
        task.name,
        masterName(task.categoryId),
        masterName(task.statusId),
        masterName(task.priorityId),
        task.assigneeIds.map(masterName).join(" "),
        task.notes
      ]
        .join(" ")
        .toLowerCase();
      return (
        (!lowerQuery || haystack.includes(lowerQuery)) &&
        (!statusFilter || task.statusId === statusFilter) &&
        (!categoryFilter || task.categoryId === categoryFilter)
      );
    });
  }, [tasks, masters, query, statusFilter, categoryFilter]);

  async function refresh() {
    try {
      const next = await invoke<AppData>("load_app_data");
      setData(next);
      setIsEditing(Boolean(next.lockState?.token));
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function run<T>(action: () => Promise<T>, success: string) {
    try {
      await action();
      setMessage(success);
      await refresh();
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function acquireEditLock() {
    localStorage.setItem("team-mgt-owner", owner);
    await run(async () => {
      await invoke<LockState>("acquire_lock", { owner });
      setIsEditing(true);
    }, "編集ロックを取得しました。");
  }

  async function releaseEditLock() {
    await run(async () => {
      await invoke("release_lock");
      setIsEditing(false);
    }, "編集ロックを解除しました。");
  }

  async function saveTask() {
    await run(async () => {
      await invoke<Task>("save_task", { task: editingTask });
      setEditingTask(blankTask());
    }, "タスクを保存しました。");
  }

  async function saveMaster() {
    await run(async () => {
      await invoke<MasterItem>("save_master", { master: editingMaster });
      setEditingMaster({ id: "", kind: editingMaster.kind, name: "", color: "#64748b", sortOrder: 100, enabled: true });
    }, "マスタを保存しました。");
  }

  async function exportWithDialog() {
    try {
      setMessage("");
      const selected = await save({
        title: "Excel の出力先を選択",
        defaultPath: excelPath || "tasks.xlsx",
        filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }]
      });
      if (!selected) {
        setMessage("Excel 出力をキャンセルしました。");
        return;
      }
      const path = selected.endsWith(".xlsx") ? selected : `${selected}.xlsx`;
      setExcelPath(path);
      await run(() => invoke("export_excel", { path }), "Excel にエクスポートしました。");
    } catch (error) {
      setMessage(`Excel 出力ダイアログを開けませんでした: ${String(error)}`);
    }
  }

  async function importWithDialog() {
    try {
      setMessage("");
      const selected = await open({
        title: "取り込む Excel ファイルを選択",
        multiple: false,
        filters: [{ name: "Excel Workbook", extensions: ["xlsx", "xlsm", "xls"] }]
      });
      if (!selected || Array.isArray(selected)) {
        setMessage("Excel 取込をキャンセルしました。");
        return;
      }
      setExcelPath(selected);
      await run(async () => {
        const report = await invoke<ImportReport>("import_excel", { path: selected });
        setMessage(`インポート: タスク ${report.importedTasks} 件 / マスタ ${report.importedMasters} 件 / エラー ${report.errors.length} 件${report.errors.length ? "\n" + report.errors.join("\n") : ""}`);
      }, "Excel をインポートしました。");
    } catch (error) {
      setMessage(`Excel 取込ダイアログを開けませんでした: ${String(error)}`);
    }
  }

  function toggleMulti(field: "assigneeIds" | "dependencyTaskIds", id: string) {
    setEditingTask((current) => {
      const values = new Set(current[field]);
      if (values.has(id)) {
        values.delete(id);
      } else {
        values.add(id);
      }
      return { ...current, [field]: [...values] };
    });
  }

  if (!data) {
    return <main className="loading">読み込み中...</main>;
  }

  return (
    <main>
      <header className="app-header">
        <div>
          <p className="eyebrow">Team Progress Manager</p>
          <h1>活動・進捗管理</h1>
          <p className="subtle">共有フォルダ運用に向いた、編集排他型のタスク管理アプリです。</p>
        </div>
        <section className="lock-card">
          <label>
            利用者名
            <input value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="例: 佐藤" />
          </label>
          {data.lockState && !isEditing ? (
            <p className="readonly">編集中: {data.lockState.owner} / {data.lockState.machine}</p>
          ) : (
            <p className={isEditing ? "editable" : "readonly"}>{isEditing ? "編集可能" : "読み取り専用"}</p>
          )}
          <button onClick={isEditing ? releaseEditLock : acquireEditLock}>{isEditing ? "編集終了" : "編集開始"}</button>
        </section>
      </header>

      <section className="toolbar">
        <label className="path-field">
          データファイル
          <input value={pathInput} onChange={(event) => setPathInput(event.target.value)} />
        </label>
        <button onClick={() => run(() => invoke<AppData>("set_database_path", { path: pathInput }).then(setData), "データファイルを切り替えました。")}>
          開く
        </button>
        <div className="excel-path">
          <span>Excel</span>
          <strong>{excelPath || "未選択"}</strong>
        </div>
        <button onClick={exportWithDialog}>Excel出力</button>
        <button disabled={!isEditing} onClick={importWithDialog}>Excel取込</button>
      </section>

      {message && <pre className="message">{message}</pre>}

      <nav className="tabs">
        <button className={activeTab === "tasks" ? "active" : ""} onClick={() => setActiveTab("tasks")}>タスク一覧</button>
        <button className={activeTab === "settings" ? "active" : ""} onClick={() => setActiveTab("settings")}>設定</button>
      </nav>

      {activeTab === "tasks" ? (
        <section className="grid-layout">
          <aside className="editor">
            <h2>{editingTask.id ? "タスク編集" : "タスク追加"}</h2>
            <label>タスク名<input disabled={!isEditing} value={editingTask.name} onChange={(event) => setEditingTask({ ...editingTask, name: event.target.value })} /></label>
            <label>カテゴリ<select disabled={!isEditing} value={editingTask.categoryId} onChange={(event) => setEditingTask({ ...editingTask, categoryId: event.target.value })}><option value="">選択</option>{byKind("category").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label>ステータス<select disabled={!isEditing} value={editingTask.statusId} onChange={(event) => setEditingTask({ ...editingTask, statusId: event.target.value })}><option value="">選択</option>{byKind("status").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label>優先度<select disabled={!isEditing} value={editingTask.priorityId} onChange={(event) => setEditingTask({ ...editingTask, priorityId: event.target.value })}><option value="">選択</option>{byKind("priority").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <div className="date-row">
              <label>開始日<input disabled={!isEditing} type="date" value={editingTask.startDate} onChange={(event) => setEditingTask({ ...editingTask, startDate: event.target.value })} /></label>
              <label>期日<input disabled={!isEditing} type="date" value={editingTask.dueDate} onChange={(event) => setEditingTask({ ...editingTask, dueDate: event.target.value })} /></label>
            </div>
            <fieldset disabled={!isEditing}>
              <legend>担当者</legend>
              {byKind("assignee").map((item) => <label className="check" key={item.id}><input type="checkbox" checked={editingTask.assigneeIds.includes(item.id)} onChange={() => toggleMulti("assigneeIds", item.id)} />{item.name}</label>)}
            </fieldset>
            <fieldset disabled={!isEditing}>
              <legend>依存タスク</legend>
              {tasks.filter((task) => task.id !== editingTask.id).map((task) => <label className="check" key={task.id}><input type="checkbox" checked={editingTask.dependencyTaskIds.includes(task.id)} onChange={() => toggleMulti("dependencyTaskIds", task.id)} />{task.name}</label>)}
            </fieldset>
            <label>メモ<textarea disabled={!isEditing} value={editingTask.notes} onChange={(event) => setEditingTask({ ...editingTask, notes: event.target.value })} /></label>
            <div className="button-row">
              <button disabled={!isEditing} onClick={saveTask}>保存</button>
              <button onClick={() => setEditingTask(blankTask())}>新規</button>
            </div>
          </aside>

          <section className="table-card">
            <div className="filters">
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="検索" />
              <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="">全カテゴリ</option>{byKind("category").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">全ステータス</option>{byKind("status").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
            </div>
            <table>
              <thead><tr><th>タスク名</th><th>カテゴリ</th><th>担当者</th><th>ステータス</th><th>優先度</th><th>期間</th><th>依存</th><th></th></tr></thead>
              <tbody>
                {filteredTasks.map((task) => (
                  <tr key={task.id}>
                    <td>{task.name}</td>
                    <td>{masterName(task.categoryId)}</td>
                    <td>{task.assigneeIds.map(masterName).join(", ")}</td>
                    <td><span className="pill">{masterName(task.statusId)}</span></td>
                    <td>{masterName(task.priorityId)}</td>
                    <td>{task.startDate} - {task.dueDate}</td>
                    <td>{task.dependencyTaskIds.map((id) => tasks.find((task) => task.id === id)?.name ?? id).join(", ")}</td>
                    <td className="actions">
                      <button onClick={() => setEditingTask(task)}>編集</button>
                      <button disabled={!isEditing} onClick={() => run(() => invoke("delete_task", { id: task.id }), "タスクを削除しました。")}>削除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </section>
      ) : (
        <section className="settings">
          <aside className="editor">
            <h2>マスタ編集</h2>
            <label>種類<select disabled={!isEditing} value={editingMaster.kind} onChange={(event) => setEditingMaster({ ...editingMaster, kind: event.target.value as MasterKind })}>{Object.entries(kindLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
            <label>名前<input disabled={!isEditing} value={editingMaster.name} onChange={(event) => setEditingMaster({ ...editingMaster, name: event.target.value })} /></label>
            <label>色<input disabled={!isEditing} type="color" value={editingMaster.color} onChange={(event) => setEditingMaster({ ...editingMaster, color: event.target.value })} /></label>
            <label>並び順<input disabled={!isEditing} type="number" value={editingMaster.sortOrder} onChange={(event) => setEditingMaster({ ...editingMaster, sortOrder: Number(event.target.value) })} /></label>
            <label className="check"><input disabled={!isEditing} type="checkbox" checked={editingMaster.enabled} onChange={(event) => setEditingMaster({ ...editingMaster, enabled: event.target.checked })} />有効</label>
            <button disabled={!isEditing} onClick={saveMaster}>保存</button>
          </aside>
          <section className="table-card">
            <table>
              <thead><tr><th>種類</th><th>名前</th><th>色</th><th>並び順</th><th>有効</th><th></th></tr></thead>
              <tbody>
                {masters.map((master) => (
                  <tr key={master.id}>
                    <td>{kindLabels[master.kind]}</td>
                    <td>{master.name}</td>
                    <td><span className="color-dot" style={{ background: master.color }} />{master.color}</td>
                    <td>{master.sortOrder}</td>
                    <td>{master.enabled ? "有効" : "無効"}</td>
                    <td className="actions">
                      <button onClick={() => setEditingMaster(master)}>編集</button>
                      <button disabled={!isEditing} onClick={() => run(() => invoke("delete_master", { id: master.id }), "マスタを削除しました。")}>削除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </section>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
