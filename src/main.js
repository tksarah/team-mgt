const STORAGE_KEY = "team-mgt.activities";

const formEl = document.querySelector("#activity-form");
const teamInputEl = document.querySelector("#team-input");
const activityInputEl = document.querySelector("#activity-input");
const progressInputEl = document.querySelector("#progress-input");
const activityListEl = document.querySelector("#activity-list");
const emptyMsgEl = document.querySelector("#empty-msg");

let activities = loadActivities();

function loadActivities() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) =>
        item &&
        typeof item.id === "number" &&
        typeof item.team === "string" &&
        typeof item.activity === "string" &&
        Number.isInteger(item.progress)
    );
  } catch {
    return [];
  }
}

function saveActivities() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(activities));
}

function createActivityItem(item) {
  const li = document.createElement("li");
  li.className = "activity-item";

  const title = document.createElement("p");
  title.className = "activity-title";
  title.textContent = `${item.team} / ${item.activity}`;

  const meta = document.createElement("p");
  meta.className = "activity-meta";
  meta.textContent = `最終更新: ${new Date(item.updatedAt).toLocaleString("ja-JP")}`;

  const controls = document.createElement("div");
  controls.className = "progress-controls";

  const progress = document.createElement("input");
  progress.type = "number";
  progress.min = "0";
  progress.max = "100";
  progress.value = String(item.progress);

  const updateButton = document.createElement("button");
  updateButton.type = "button";
  updateButton.textContent = "進捗更新";
  updateButton.addEventListener("click", () => {
    const nextProgress = Number(progress.value);
    if (!Number.isFinite(nextProgress) || nextProgress < 0 || nextProgress > 100) {
      return;
    }

    activities = activities.map((activity) =>
      activity.id === item.id
        ? {
            ...activity,
            progress: Math.trunc(nextProgress),
            updatedAt: Date.now(),
          }
        : activity
    );

    saveActivities();
    render();
  });

  const value = document.createElement("span");
  value.className = "progress-value";
  value.textContent = `${item.progress}%`;

  controls.append(progress, updateButton, value);

  const bar = document.createElement("progress");
  bar.max = 100;
  bar.value = item.progress;

  li.append(title, meta, controls, bar);
  return li;
}

function render() {
  activityListEl.innerHTML = "";
  emptyMsgEl.hidden = activities.length > 0;

  activities
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .forEach((item) => {
      activityListEl.append(createActivityItem(item));
    });
}

formEl.addEventListener("submit", (event) => {
  event.preventDefault();

  const team = teamInputEl.value.trim();
  const activity = activityInputEl.value.trim();
  const progress = Number(progressInputEl.value);

  if (!team || !activity || !Number.isFinite(progress) || progress < 0 || progress > 100) {
    return;
  }

  activities.push({
    id: Date.now() + Math.floor(Math.random() * 1000),
    team,
    activity,
    progress: Math.trunc(progress),
    updatedAt: Date.now(),
  });

  formEl.reset();
  progressInputEl.value = "0";
  saveActivities();
  render();
});

render();
