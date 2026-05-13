import { memo, useCallback, useEffect, useMemo, useState } from "react";
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

type TaskTreeRow = {
  task: Task;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
};

type TaskEditorProps = {
  editingTask: Task;
  isEditing: boolean;
  isCollapsed: boolean;
  categoryOptions: MasterItem[];
  statusOptions: MasterItem[];
  priorityOptions: MasterItem[];
  assigneeOptions: MasterItem[];
  dependencyOptions: Task[];
  onToggleCollapsed: () => void;
  onUpdateField: <K extends keyof Task>(field: K, value: Task[K]) => void;
  onToggleAssignee: (id: string) => void;
  onSetDependencyTaskId: (id: string) => void;
  onSave: () => void;
  onStartNew: () => void;
};

type TaskTableProps = {
  query: string;
  categoryFilter: string;
  statusFilter: string;
  categoryOptions: MasterItem[];
  statusOptions: MasterItem[];
  taskTreeRows: TaskTreeRow[];
  isEditing: boolean;
  masterName: (id: string) => string;
  taskNameById: Map<string, string>;
  onSetQuery: (value: string) => void;
  onSetCategoryFilter: (value: string) => void;
  onSetStatusFilter: (value: string) => void;
  onToggleExpanded: (taskId: string, nextExpanded: boolean) => void;
  onEditTask: (task: Task) => void;
  onDeleteTask: (taskId: string) => void;
};

type MasterEditorProps = {
  editingMaster: MasterItem;
  isEditing: boolean;
  onUpdateMaster: <K extends keyof MasterItem>(field: K, value: MasterItem[K]) => void;
  onSaveMaster: () => void;
};

type MasterTableProps = {
  masters: MasterItem[];
  isEditing: boolean;
  onSelectMaster: (master: MasterItem) => void;
  onDeleteMaster: (id: string) => void;
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

const previewNotes = (notes: string) => (notes.length > 20 ? `${notes.slice(0, 20)}…` : notes);

const upsertById = <T extends { id: string }>(items: T[], nextItem: T) => {
  const index = items.findIndex((item) => item.id === nextItem.id);
  if (index === -1) {
    return [...items, nextItem];
  }

  const nextItems = [...items];
  nextItems[index] = nextItem;
  return nextItems;
};

const TaskEditor = memo(function TaskEditor({
  editingTask,
  isEditing,
  isCollapsed,
  categoryOptions,
  statusOptions,
  priorityOptions,
  assigneeOptions,
  dependencyOptions,
  onToggleCollapsed,
  onUpdateField,
  onToggleAssignee,
  onSetDependencyTaskId,
  onSave,
  onStartNew
}: TaskEditorProps) {
  return (
    <aside className={isCollapsed ? "editor task-editor is-collapsed" : "editor task-editor"}>
      <div className="editor-header">
        <h2>{editingTask.id ? "タスク編集" : "タスク追加"}</h2>
        <button type="button" className="toggle-editor" onClick={onToggleCollapsed} aria-expanded={!isCollapsed}>
          {isCollapsed ? "開く" : "閉じる"}
        </button>
      </div>
      {!isCollapsed && (
        <>
          <label>タスク名<input disabled={!isEditing} value={editingTask.name} onChange={(event) => onUpdateField("name", event.target.value)} /></label>
          <label>カテゴリ<select disabled={!isEditing} value={editingTask.categoryId} onChange={(event) => onUpdateField("categoryId", event.target.value)}><option value="">選択</option>{categoryOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>ステータス<select disabled={!isEditing} value={editingTask.statusId} onChange={(event) => onUpdateField("statusId", event.target.value)}><option value="">選択</option>{statusOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>優先度<select disabled={!isEditing} value={editingTask.priorityId} onChange={(event) => onUpdateField("priorityId", event.target.value)}><option value="">選択</option>{priorityOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <div className="date-row">
            <label>開始日<input disabled={!isEditing} type="date" value={editingTask.startDate} onChange={(event) => onUpdateField("startDate", event.target.value)} /></label>
            <label>期日<input disabled={!isEditing} type="date" value={editingTask.dueDate} onChange={(event) => onUpdateField("dueDate", event.target.value)} /></label>
          </div>
          <fieldset disabled={!isEditing}>
            <legend>担当者</legend>
            {assigneeOptions.map((item) => <label className="check" key={item.id}><input type="checkbox" checked={editingTask.assigneeIds.includes(item.id)} onChange={() => onToggleAssignee(item.id)} />{item.name}</label>)}
          </fieldset>
          <fieldset disabled={!isEditing}>
            <legend>依存タスク（1件まで）</legend>
            <label>
              直接依存先
              <select value={editingTask.dependencyTaskIds[0] ?? ""} onChange={(event) => onSetDependencyTaskId(event.target.value)}>
                <option value="">なし</option>
                {dependencyOptions.map((task) => <option key={task.id} value={task.id}>{task.name}</option>)}
              </select>
            </label>
          </fieldset>
          <label>メモ<textarea disabled={!isEditing} value={editingTask.notes} onChange={(event) => onUpdateField("notes", event.target.value)} /></label>
          <div className="button-row">
            <button disabled={!isEditing} onClick={onSave}>保存</button>
            <button onClick={onStartNew}>新規</button>
          </div>
        </>
      )}
    </aside>
  );
});

const TaskTable = memo(function TaskTable({
  query,
  categoryFilter,
  statusFilter,
  categoryOptions,
  statusOptions,
  taskTreeRows,
  isEditing,
  masterName,
  taskNameById,
  onSetQuery,
  onSetCategoryFilter,
  onSetStatusFilter,
  onToggleExpanded,
  onEditTask,
  onDeleteTask
}: TaskTableProps) {
  return (
    <section className="table-card">
      <div className="filters">
        <input value={query} onChange={(event) => onSetQuery(event.target.value)} placeholder="検索" />
        <select value={categoryFilter} onChange={(event) => onSetCategoryFilter(event.target.value)}><option value="">全カテゴリ</option>{categoryOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        <select value={statusFilter} onChange={(event) => onSetStatusFilter(event.target.value)}><option value="">全ステータス</option>{statusOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      </div>
      <table>
        <thead><tr><th>タスク名</th><th>カテゴリ</th><th>担当者</th><th>ステータス</th><th>優先度</th><th>期間</th><th>メモ</th><th>依存</th><th></th></tr></thead>
        <tbody>
          {taskTreeRows.map(({ task, depth, hasChildren, isExpanded }) => (
            <tr
              key={task.id}
              className={`tree-row${hasChildren ? " tree-row-parent" : ""}${isExpanded ? " tree-row-expanded" : ""}`}
            >
              <td>
                <div className="tree-cell">
                  <span className="tree-indent" style={{ width: `${depth * 20}px` }} aria-hidden="true" />
                  {hasChildren ? (
                    <button
                      type="button"
                      className="tree-toggle"
                      aria-expanded={isExpanded}
                      aria-label={isExpanded ? `${task.name} の子タスクを折りたたむ` : `${task.name} の子タスクを展開する`}
                      onClick={() => onToggleExpanded(task.id, !isExpanded)}
                    ><span className="tree-toggle-icon" aria-hidden="true" /></button>
                  ) : (
                    <span className="tree-toggle-spacer" aria-hidden="true" />
                  )}
                  <span className="tree-task-name">{task.name}</span>
                </div>
              </td>
              <td>{masterName(task.categoryId)}</td>
              <td>{task.assigneeIds.map(masterName).join(", ")}</td>
              <td><span className="pill">{masterName(task.statusId)}</span></td>
              <td>{masterName(task.priorityId)}</td>
              <td>{task.startDate} - {task.dueDate}</td>
              <td className="memo-preview" title={task.notes}>{previewNotes(task.notes)}</td>
              <td>{task.dependencyTaskIds.map((id) => taskNameById.get(id) ?? id).join(", ")}</td>
              <td className="actions">
                <button onClick={() => onEditTask(task)}>編集</button>
                <button disabled={!isEditing} onClick={() => onDeleteTask(task.id)}>削除</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
});

const MasterEditor = memo(function MasterEditor({
  editingMaster,
  isEditing,
  onUpdateMaster,
  onSaveMaster
}: MasterEditorProps) {
  return (
    <aside className="editor">
      <h2>マスタ編集</h2>
      <label>種類<select disabled={!isEditing} value={editingMaster.kind} onChange={(event) => onUpdateMaster("kind", event.target.value as MasterKind)}>{Object.entries(kindLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>名前<input disabled={!isEditing} value={editingMaster.name} onChange={(event) => onUpdateMaster("name", event.target.value)} /></label>
      <label>色<input disabled={!isEditing} type="color" value={editingMaster.color} onChange={(event) => onUpdateMaster("color", event.target.value)} /></label>
      <label>並び順<input disabled={!isEditing} type="number" value={editingMaster.sortOrder} onChange={(event) => onUpdateMaster("sortOrder", Number(event.target.value))} /></label>
      <label className="check"><input disabled={!isEditing} type="checkbox" checked={editingMaster.enabled} onChange={(event) => onUpdateMaster("enabled", event.target.checked)} />有効</label>
      <button disabled={!isEditing} onClick={onSaveMaster}>保存</button>
    </aside>
  );
});

const MasterTable = memo(function MasterTable({
  masters,
  isEditing,
  onSelectMaster,
  onDeleteMaster
}: MasterTableProps) {
  return (
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
                <button onClick={() => onSelectMaster(master)}>編集</button>
                <button disabled={!isEditing} onClick={() => onDeleteMaster(master.id)}>削除</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
});

export default function App() {
  const [data, setData] = useState<AppData | null>(null);
  const [activeTab, setActiveTab] = useState<"tasks" | "settings">("tasks");
  const [editingTask, setEditingTask] = useState<Task>(blankTask());
  const [isTaskEditorCollapsed, setIsTaskEditorCollapsed] = useState(true);
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
  const [expandedTaskIds, setExpandedTaskIds] = useState<Record<string, boolean>>({});

  const masters = data?.masters ?? [];
  const tasks = data?.tasks ?? [];
  const isEditing = Boolean(data?.lockState?.token);

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (data?.databasePath) {
      setPathInput(data.databasePath);
    }
  }, [data?.databasePath]);

  const mastersByKind = useMemo(() => {
    const grouped: Record<MasterKind, MasterItem[]> = {
      category: [],
      assignee: [],
      status: [],
      priority: []
    };

    for (const item of masters) {
      if (item.enabled) {
        grouped[item.kind].push(item);
      }
    }

    for (const kind of Object.keys(grouped) as MasterKind[]) {
      grouped[kind].sort((a, b) => a.sortOrder - b.sortOrder);
    }

    return grouped;
  }, [masters]);

  const masterNameById = useMemo(() => new Map(masters.map((item) => [item.id, item.name])), [masters]);

  const taskNameById = useMemo(() => new Map(tasks.map((task) => [task.id, task.name])), [tasks]);

  const categoryOptions = mastersByKind.category;
  const assigneeOptions = mastersByKind.assignee;
  const statusOptions = mastersByKind.status;
  const priorityOptions = mastersByKind.priority;

  const masterName = useCallback((id: string) => masterNameById.get(id) ?? id, [masterNameById]);

  const dependencyOptions = useMemo(
    () => tasks.filter((task) => task.id !== editingTask.id),
    [tasks, editingTask.id]
  );

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
  }, [tasks, masterNameById, query, statusFilter, categoryFilter]);

  const taskTreeRows = useMemo(() => {
    const filteredTaskIds = new Set(filteredTasks.map((task) => task.id));
    const childrenByParent = new Map<string, Task[]>();
    const roots: Task[] = [];

    for (const task of filteredTasks) {
      const parentId = task.dependencyTaskIds[0];
      if (parentId && filteredTaskIds.has(parentId)) {
        const siblings = childrenByParent.get(parentId) ?? [];
        siblings.push(task);
        childrenByParent.set(parentId, siblings);
      } else {
        roots.push(task);
      }
    }

    const rows: TaskTreeRow[] = [];
    const visited = new Set<string>();

    const visit = (task: Task, depth: number) => {
      if (visited.has(task.id)) {
        return;
      }
      visited.add(task.id);
      const children = childrenByParent.get(task.id) ?? [];
      const isExpanded = expandedTaskIds[task.id] ?? depth === 0;
      rows.push({ task, depth, hasChildren: children.length > 0, isExpanded });
      if (!isExpanded) {
        return;
      }
      for (const child of children) {
        visit(child, depth + 1);
      }
    };

    for (const root of roots) {
      visit(root, 0);
    }

    for (const task of filteredTasks) {
      if (!visited.has(task.id)) {
        visit(task, 0);
      }
    }

    return rows;
  }, [filteredTasks, expandedTaskIds]);

  async function refresh() {
    try {
      const next = await invoke<AppData>("load_app_data");
      setData(next);
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

  function updateLockState(lockState: LockState | null) {
    setData((current) => (current ? { ...current, lockState } : current));
  }

  const updateTasks = useCallback((updater: (tasks: Task[]) => Task[]) => {
    setData((current) => (current ? { ...current, tasks: updater(current.tasks) } : current));
  }, []);

  const updateMasters = useCallback((updater: (masters: MasterItem[]) => MasterItem[]) => {
    setData((current) => (current ? { ...current, masters: updater(current.masters) } : current));
  }, []);

  const updateTaskField = useCallback(<K extends keyof Task>(field: K, value: Task[K]) => {
    setEditingTask((current) => ({ ...current, [field]: value }));
  }, []);

  const updateMasterField = useCallback(<K extends keyof MasterItem>(field: K, value: MasterItem[K]) => {
    setEditingMaster((current) => ({ ...current, [field]: value }));
  }, []);

  async function acquireEditLock() {
    localStorage.setItem("team-mgt-owner", owner);
    try {
      const lockState = await invoke<LockState>("acquire_lock", { owner });
      updateLockState(lockState);
      setMessage("編集ロックを取得しました。");
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function releaseEditLock() {
    try {
      await invoke("release_lock");
      updateLockState(null);
      setMessage("編集ロックを解除しました。");
    } catch (error) {
      setMessage(String(error));
    }
  }

  const saveTask = useCallback(async () => {
    try {
      const savedTask = await invoke<Task>("save_task", { task: editingTask });
      updateTasks((current) => upsertById(current, savedTask));
      setEditingTask(blankTask());
      setMessage("タスクを保存しました。");
    } catch (error) {
      setMessage(String(error));
    }
  }, [editingTask, updateTasks]);

  const startTaskEdit = useCallback((task: Task) => {
    setEditingTask(task);
    setIsTaskEditorCollapsed(false);
  }, []);

  const startNewTask = useCallback(() => {
    setEditingTask(blankTask());
    setIsTaskEditorCollapsed(false);
  }, []);

  const saveMaster = useCallback(async () => {
    try {
      const savedMaster = await invoke<MasterItem>("save_master", { master: editingMaster });
      updateMasters((current) => upsertById(current, savedMaster));
      setEditingMaster({ id: "", kind: editingMaster.kind, name: "", color: "#64748b", sortOrder: 100, enabled: true });
      setMessage("マスタを保存しました。");
    } catch (error) {
      setMessage(String(error));
    }
  }, [editingMaster, updateMasters]);

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

  async function openDatabaseWithDialog() {
    try {
      setMessage("");
      const selected = await open({
        title: "データファイルを選択",
        defaultPath: pathInput || data?.databasePath,
        multiple: false,
        filters: [{ name: "SQLite Database", extensions: ["sqlite", "db"] }]
      });
      if (!selected || Array.isArray(selected)) {
        setMessage("データファイルの選択をキャンセルしました。");
        return;
      }
      setPathInput(selected);
      const next = await invoke<AppData>("set_database_path", { path: selected });
      setData(next);
      setMessage("データファイルを切り替えました。");
    } catch (error) {
      setMessage(`データファイル選択ダイアログを開けませんでした: ${String(error)}`);
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

  const toggleMulti = useCallback((field: "assigneeIds" | "dependencyTaskIds", id: string) => {
    setEditingTask((current) => {
      const values = new Set(current[field]);
      if (values.has(id)) {
        values.delete(id);
      } else {
        values.add(id);
      }
      return { ...current, [field]: [...values] };
    });
  }, []);

  const toggleAssignee = useCallback((id: string) => {
    toggleMulti("assigneeIds", id);
  }, [toggleMulti]);

  const setDependencyTaskId = useCallback((id: string) => {
    setEditingTask((current) => ({
      ...current,
      dependencyTaskIds: id ? [id] : []
    }));
  }, []);

  const toggleTaskExpanded = useCallback((taskId: string, nextExpanded: boolean) => {
    setExpandedTaskIds((current) => ({ ...current, [taskId]: nextExpanded }));
  }, []);

  const deleteTask = useCallback((taskId: string) => {
    void (async () => {
      try {
        await invoke("delete_task", { id: taskId });
        updateTasks((current) => current.filter((task) => task.id !== taskId));
        setMessage("タスクを削除しました。");
      } catch (error) {
        setMessage(String(error));
      }
    })();
  }, [updateTasks]);

  const deleteMaster = useCallback((masterId: string) => {
    void (async () => {
      try {
        await invoke("delete_master", { id: masterId });
        updateMasters((current) => current.filter((master) => master.id !== masterId));
        setMessage("マスタを削除しました。");
      } catch (error) {
        setMessage(String(error));
      }
    })();
  }, [updateMasters]);

  const toggleTaskEditorCollapsed = useCallback(() => {
    setIsTaskEditorCollapsed((collapsed) => !collapsed);
  }, []);

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
        <button onClick={openDatabaseWithDialog}>
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
        <section className={isTaskEditorCollapsed ? "grid-layout task-editor-collapsed" : "grid-layout"}>
          <TaskEditor
            editingTask={editingTask}
            isEditing={isEditing}
            isCollapsed={isTaskEditorCollapsed}
            categoryOptions={categoryOptions}
            statusOptions={statusOptions}
            priorityOptions={priorityOptions}
            assigneeOptions={assigneeOptions}
            dependencyOptions={dependencyOptions}
            onToggleCollapsed={toggleTaskEditorCollapsed}
            onUpdateField={updateTaskField}
            onToggleAssignee={toggleAssignee}
            onSetDependencyTaskId={setDependencyTaskId}
            onSave={saveTask}
            onStartNew={startNewTask}
          />

          <TaskTable
            query={query}
            categoryFilter={categoryFilter}
            statusFilter={statusFilter}
            categoryOptions={categoryOptions}
            statusOptions={statusOptions}
            taskTreeRows={taskTreeRows}
            isEditing={isEditing}
            masterName={masterName}
            taskNameById={taskNameById}
            onSetQuery={setQuery}
            onSetCategoryFilter={setCategoryFilter}
            onSetStatusFilter={setStatusFilter}
            onToggleExpanded={toggleTaskExpanded}
            onEditTask={startTaskEdit}
            onDeleteTask={deleteTask}
          />
        </section>
      ) : (
        <section className="settings">
          <MasterEditor
            editingMaster={editingMaster}
            isEditing={isEditing}
            onUpdateMaster={updateMasterField}
            onSaveMaster={saveMaster}
          />
          <MasterTable
            masters={masters}
            isEditing={isEditing}
            onSelectMaster={setEditingMaster}
            onDeleteMaster={deleteMaster}
          />
        </section>
      )}
    </main>
  );
}