import '../style/index.css';

import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import {
  MainAreaWidget,
  ReactWidget
} from '@jupyterlab/apputils';
import { PathExt, URLExt } from '@jupyterlab/coreutils';
import { NotebookPanel, INotebookTracker } from '@jupyterlab/notebook';
import { Contents, ServerConnection } from '@jupyterlab/services';
import { LabIcon, ToolbarButton } from '@jupyterlab/ui-components';
import { Message } from '@lumino/messaging';
import React from 'react';

const nitroJudgeIcon = new LabIcon({
  name: 'jupyterlab-nitro-ai-judge:nitro-logo',
  svgstr:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path fill="none" stroke="#e67251" stroke-linecap="round" stroke-linejoin="round" stroke-width="14" d="M38 74c24 8 24 36 14 67-10 33 5 72 53 82 56 12 115-18 134-70 9-24 9-45 5-63-1 44-32 71-73 73-30 1-63-12-80-22"/><path fill="none" stroke="#e67251" stroke-linecap="round" stroke-linejoin="round" stroke-width="10" d="M34 72c12-4 10-17 18-27 13-16 37-15 51 1 17 19 3 54 8 83 2 13 9 27 23 34 20 10 44 13 67-5 15-12 14-27 7-36"/><circle cx="89" cy="128" r="9" fill="none" stroke="#e67251" stroke-width="8"/></svg>'
});

type LoginStatus = {
  loggedIn: boolean;
  username: string | null;
  tokenLogin?: boolean;
  authenticated?: boolean;
};

type Contest = {
  org: string;
  slug: string;
  title: string;
  competitionStart: number | string | null;
  competitionEnd: number | string | null;
  hasStarted: boolean;
  isRunning: boolean;
  hasAccess: boolean;
};

type Task = {
  id: string;
  title: string;
  synopsis: string;
};

type SubmissionSubtask = {
  id: string | number;
  title: string;
  metricName: string;
  maxScore: number | string | null;
  partialScore: number | string | null;
  partialMetric: number | string | null;
  completeScore: number | string | null;
  completeMetric: number | string | null;
};

type SubmissionResult = {
  id: string;
  state: string;
  partialScore: number | string | null;
  completeScore: number | string | null;
  createdAt?: string | null;
  prejudgingScriptOutput?: string | null;
  subtasks: SubmissionSubtask[];
};

type TaskDataCategory = 'statement' | 'train_data' | 'test_data' | 'sample_output' | 'custom_archive' | 'pre_judging_script';

type TaskDataOption = {
  value: TaskDataCategory;
  label: string;
  available: boolean;
};

type SourceMode = 'notebook' | 'file' | 'none';

type StoredPanelCache = {
  version: number;
  savedAt: number;
  contests: Contest[];
  tasks: Record<string, Task[]>;
};

type NotebookCellJSON = {
  cell_type?: string;
  source?: string | string[];
};

type NotebookJSON = {
  cells?: NotebookCellJSON[];
};

const TASK_DATA_CATEGORIES: Array<{ value: TaskDataCategory; label: string }> = [
  { value: 'statement', label: 'Statement' },
  { value: 'train_data', label: 'Train data' },
  { value: 'test_data', label: 'Test data' },
  { value: 'sample_output', label: 'Sample output' },
  { value: 'custom_archive', label: 'Starter kit' },
  { value: 'pre_judging_script', label: 'Pre-judging script' }
];

function visibleContests(contests: Contest[]): Contest[] {
  return contests.filter(contest => contest.hasAccess !== false && contest.hasStarted);
}

function stripContestTags(title: string): string {
  return title.replace(/\s*\((?:ended|remade)\)\s*$/gi, '').trim();
}

type FilePickerOptions = {
  acceptFile?: (item: Contents.IModel) => boolean;
  emptyMessage?: string;
};

type PickerEntry = {
  name: string;
  path: string;
  type: Contents.ContentType;
};

type PickerState = {
  currentPath: string;
  emptyMessage: string;
  entries: PickerEntry[];
  error: string | null;
  loading: boolean;
  selectedPath: string | null;
  selectedType: Contents.ContentType | null;
  title: string;
  acceptFile?: (item: Contents.IModel) => boolean;
};

let contestCache: Contest[] | null = null;
const taskCache = new Map<string, Task[]>();
const PANEL_CACHE_VERSION = 2;
const PANEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function panelCacheKey(username: string | null): string {
  return `jupyterlab-nitro-ai-judge:v${PANEL_CACHE_VERSION}:${username || 'anonymous'}`;
}

function readPanelCache(username: string | null): StoredPanelCache | null {
  try {
    const raw = window.localStorage.getItem(panelCacheKey(username));
    if (!raw) {
      return null;
    }
    const cache = JSON.parse(raw) as StoredPanelCache;
    if (
      cache.version !== PANEL_CACHE_VERSION ||
      !Array.isArray(cache.contests) ||
      typeof cache.tasks !== 'object' ||
      Date.now() - cache.savedAt > PANEL_CACHE_TTL_MS
    ) {
      return null;
    }
    return cache;
  } catch {
    return null;
  }
}

function writePanelCache(username: string | null, contests: Contest[], tasks: Map<string, Task[]>): void {
  try {
    window.localStorage.setItem(
      panelCacheKey(username),
      JSON.stringify({
        version: PANEL_CACHE_VERSION,
        savedAt: Date.now(),
        contests,
        tasks: Object.fromEntries(tasks)
      } satisfies StoredPanelCache)
    );
  } catch {
    // Browser storage can be unavailable or full; in-memory cache still works.
  }
}

function clearPanelCache(username: string | null): void {
  try {
    window.localStorage.removeItem(panelCacheKey(username));
  } catch {
    // Browser storage can be unavailable; there is nothing else to clear.
  }
}

async function requestAPI<T>(
  endPoint: string,
  init: RequestInit = {}
): Promise<T> {
  const settings = ServerConnection.makeSettings();
  const requestUrl = URLExt.join(settings.baseUrl, 'nitro-ai-judge', endPoint);

  const response = await ServerConnection.makeRequest(requestUrl, init, settings);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data.message ?? data.reason ?? response.statusText;
    throw new Error(String(message));
  }

  return data as T;
}

function notebookDirectory(panel: NotebookPanel): string {
  const dir = PathExt.dirname(panel.context.path);
  return dir === '.' ? '' : dir;
}

function notebookSourceFilename(panel: NotebookPanel): string {
  const basename = PathExt.basename(panel.context.path || 'notebook.ipynb').replace(/\.ipynb$/i, '');
  return `${basename || 'notebook'}_export.py`;
}

function notebookSourceFilenameFromPath(path: string): string {
  const basename = PathExt.basename(path || 'notebook.ipynb').replace(/\.ipynb$/i, '');
  return `${basename || 'notebook'}_export.py`;
}

function notebookSourceContentFromNotebook(notebook: NotebookJSON | undefined | null): string {
  const cells = Array.isArray(notebook?.cells) ? notebook.cells : [];
  const chunks = cells
    .filter(cell => cell.cell_type === 'code')
    .map(cell => (Array.isArray(cell.source) ? cell.source.join('') : cell.source ?? '').trimEnd());

  return `${chunks.join('\n\n')}\n`;
}

function notebookSourceContent(panel: NotebookPanel): string {
  return notebookSourceContentFromNotebook(panel.content.model?.toJSON() as NotebookJSON | undefined);
}

function notebookSourceContentFromModel(model: Contents.IModel | undefined | null): string {
  const content = model?.content;
  const notebook =
    typeof content === 'string'
      ? (() => {
          try {
            return JSON.parse(content) as NotebookJSON;
          } catch {
            return null;
          }
        })()
      : (content as NotebookJSON | undefined | null);
  return notebookSourceContentFromNotebook(notebook);
}

function sourceSelectionKind(path: string): 'notebook' | 'source' | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.ipynb')) {
    return 'notebook';
  }
  if (lower.endsWith('.py')) {
    return 'source';
  }
  return null;
}

function contestDisplayLabel(contest: Contest): string {
  const value = stripContestTags(contest.title || `${contest.org}/${contest.slug}`);
  return value || `${contest.org}/${contest.slug}`;
}

function contestStatusLabel(contest: Contest): string {
  return contest.isRunning ? 'Running' : 'Closed';
}

function contestDateValue(contest: Contest): number {
  const raw = contest.competitionStart ?? contest.competitionEnd;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : 0;
  }
  if (typeof raw === 'string') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
    const date = Date.parse(raw);
    if (Number.isFinite(date)) {
      return date;
    }
  }
  return 0;
}

function contestSearchText(contest: Contest): string {
  return [contest.title, contestDisplayLabel(contest), contest.org, contest.slug, `${contest.org}/${contest.slug}`]
    .join(' ')
    .toLowerCase();
}

function taskDisplayLabel(task: Task): string {
  return task.title?.trim() || task.id;
}

function taskSearchText(task: Task): string {
  return [task.id, task.title, task.synopsis].join(' ').toLowerCase();
}

function normalizeTaskDataCategory(rawCategory: string, label?: string): TaskDataCategory | null {
  const normalized = `${rawCategory} ${label ?? ''}`.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!normalized) {
    return null;
  }
  if (normalized.includes('prejudg') && normalized.includes('script')) {
    return 'pre_judging_script';
  }
  if (normalized.includes('sampleoutput')) {
    return 'sample_output';
  }
  if (normalized.includes('customarchive') || normalized.includes('starterkit')) {
    return 'custom_archive';
  }
  if (normalized.includes('traindata')) {
    return 'train_data';
  }
  if (normalized.includes('testdata')) {
    return 'test_data';
  }
  if (normalized.includes('statement')) {
    return 'statement';
  }
  return null;
}

function canSelectContest(contest: Contest): boolean {
  return contest.hasStarted;
}

class NitroJudgeBody extends ReactWidget {
  constructor(app: JupyterFrontEnd, panel: NotebookPanel) {
    super();
    this.addClass('jp-NitroJudgePanel');
    this._app = app;
    this._panel = panel;
    this._dataOutputDir = notebookDirectory(panel);
  }

  protected onAfterAttach(msg: Message): void {
    super.onAfterAttach(msg);
    if (!this._initialized) {
      this._initialized = true;
      void this._initialize();
    }
  }

  render(): React.JSX.Element {
    const loadingText = this._busy ? this._busyMessage || 'Working...' : null;
    const currentNotebook = this._currentNotebookPanel();
    const filteredContests = this._filteredContests();
    const filteredTasks = this._filteredTasks();
    const visibleContestCount = visibleContests(this._contests).length;
    const pickerState = this._pickerState;
    const visibleTaskCount = this._tasks.length;
    const sourceKind = this._sourcePath ? sourceSelectionKind(this._sourcePath) : null;
    const sourceLabel = this._sourcePath
      ? sourceKind === 'notebook'
        ? `Notebook file selected: ${PathExt.basename(this._sourcePath)}`
        : sourceKind === 'source'
          ? `Python source selected: ${PathExt.basename(this._sourcePath)}`
          : this._sourcePath
      : 'Using current notebook';

    return (
      <div className="jp-NitroJudgeRoot">
        <p className="jp-NitroJudgeNotebookPath">
          Notebook: <code>{currentNotebook.context.path || this._panel.context.path}</code>
        </p>

        {this._error ? (
          <div className="jp-NitroJudgeMessage" data-kind="error">
            {this._error}
          </div>
        ) : null}

        {loadingText ? (
          <div className="jp-NitroJudgeMessage" data-kind="info">
            {loadingText}
          </div>
        ) : null}

        <section>
          <div className="jp-NitroJudgeSectionHeader">
            <h3>Login</h3>
            <p className="jp-NitroJudgeMuted">Sign in to load your contests and tasks.</p>
          </div>
          <div className="jp-NitroJudgeSectionBody">
            {this._status.loggedIn ? (
              <p className="jp-NitroJudgeStatusLine">
                <span>
                  Logged in as <strong>{this._status.username}</strong>.
                </span>
              </p>
            ) : (
              <div className="jp-NitroJudgeGrid jp-NitroJudgeLoginGrid">
                <label className="jp-NitroJudgeFieldLabel">
                  <span className="jp-NitroJudgeFieldTitle">Username</span>
                  <input
                    value={this._username}
                    onChange={event => {
                      this._username = event.currentTarget.value;
                      this.update();
                    }}
                    placeholder="Nitro username"
                    type="text"
                  />
                </label>
                <label className="jp-NitroJudgeFieldLabel">
                  <span className="jp-NitroJudgeFieldTitle">Password</span>
                  <input
                    value={this._password}
                    onChange={event => {
                      this._password = event.currentTarget.value;
                      this.update();
                    }}
                    placeholder="Nitro password"
                    type="password"
                  />
                </label>
                <div className="jp-NitroJudgeActions jp-NitroJudgeLoginActions">
                  <button
                    className="jp-NitroJudgeActionButton jp-NitroJudgeActionButtonPrimary"
                    disabled={this._busy}
                    onClick={() => void this._login()}
                    type="button"
                  >
                    Log in
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>

        <section>
          <div className="jp-NitroJudgeSectionHeader">
            <h3>Submission</h3>
            <p className="jp-NitroJudgeMuted">Choose the task, output file, and source to submit.</p>
          </div>
          <div className="jp-NitroJudgeSectionBody">
            <div className="jp-NitroJudgeSubmissionLayout">
              <div className="jp-NitroJudgeSubmissionSidebar">
                <div className="jp-NitroJudgeContestFinder">
                  <div className="jp-NitroJudgeContestFinderBar">
                    <label className="jp-NitroJudgeFieldLabel jp-NitroJudgeContestSearch">
                      <span className="jp-NitroJudgeFieldTitle">Contest</span>
                      <input
                        disabled={!this._status.loggedIn || this._busy}
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                        onChange={event => {
                          this._contestQuery = event.currentTarget.value;
                          this.update();
                        }}
                        onKeyDown={event => {
                          if (event.key === 'Escape' && this._contestQuery) {
                            this._contestQuery = '';
                            this.update();
                            return;
                          }
                          if (event.key === 'Enter') {
                            const match = filteredContests[0];
                            if (match) {
                              event.preventDefault();
                              void this._selectContest(`${match.org}/${match.slug}`);
                            }
                          }
                        }}
                        placeholder="Search by title, org, or slug"
                        type="search"
                        value={this._contestQuery}
                      />
                    </label>
                    <div className="jp-NitroJudgeContestSearchActions">
                      <button
                        className="jp-NitroJudgeActionButton"
                        disabled={!this._contestQuery || this._busy}
                        onClick={() => {
                          this._contestQuery = '';
                          this.update();
                        }}
                        type="button"
                      >
                        Clear
                      </button>
                      <button
                        className="jp-NitroJudgeActionButton jp-NitroJudgeContestRefresh"
                        disabled={this._busy || !this._status.loggedIn}
                        onClick={() => void this._loadContests({ force: true })}
                        type="button"
                      >
                        Refresh
                      </button>
                    </div>
                  </div>

                  <div className="jp-NitroJudgeContestFinderMeta">
                    <p className="jp-NitroJudgeMuted">
                      {this._status.loggedIn
                        ? `Showing ${filteredContests.length} of ${visibleContestCount} contests.`
                        : 'Showing 0 of 0 contests.'}
                    </p>
                  </div>

                  <div className="jp-NitroJudgeContestList" aria-label="Contest search results" role="listbox">
                    {this._status.loggedIn ? (
                      filteredContests.length ? (
                        filteredContests.map(contest => {
                          const value = `${contest.org}/${contest.slug}`;
                          const isSelected =
                            this._selectedContest?.org === contest.org && this._selectedContest?.slug === contest.slug;
                          return (
                            <button
                              aria-selected={isSelected}
                              className="jp-NitroJudgeContestItem"
                              data-selected={isSelected}
                              key={value}
                              title={`${contestDisplayLabel(contest)} (${contest.org}/${contest.slug})`}
                              onClick={() => void this._selectContest(value)}
                              role="option"
                              type="button"
                            >
                              <span className="jp-NitroJudgeContestItemMain">
                                <strong>{contestDisplayLabel(contest)}</strong>
                                <span className="jp-NitroJudgeMuted">
                                  {contest.org}/{contest.slug}
                                </span>
                              </span>
                              <span className="jp-NitroJudgeContestBadge" data-state={contest.isRunning ? 'running' : 'closed'}>
                                {contestStatusLabel(contest)}
                              </span>
                            </button>
                          );
                        })
                      ) : (
                        <p className="jp-NitroJudgeContestEmpty">No contests match that search.</p>
                      )
                    ) : (
                      <div className="jp-NitroJudgeContestEmpty jp-NitroJudgeTaskEmptyBox" aria-hidden="true" />
                    )}
                  </div>
                </div>
              </div>

              <div className="jp-NitroJudgeSubmissionMain">
                <div className="jp-NitroJudgeTaskFinder">
                  <div className="jp-NitroJudgeTaskFinderBar">
                    <label className="jp-NitroJudgeFieldLabel jp-NitroJudgeContestSearch">
                      <span className="jp-NitroJudgeFieldTitle">Task</span>
                      <input
                        disabled={!this._selectedContest || this._busy}
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                        onChange={event => {
                          this._taskQuery = event.currentTarget.value;
                          this.update();
                        }}
                        onKeyDown={event => {
                          if (event.key === 'Escape' && this._taskQuery) {
                            this._taskQuery = '';
                            this.update();
                            return;
                          }
                          if (event.key === 'Enter') {
                            const match = filteredTasks[0];
                            if (match) {
                              event.preventDefault();
                              void this._selectTask(match.id);
                            }
                          }
                        }}
                        placeholder="Search by id, title, or synopsis"
                        type="search"
                        value={this._taskQuery}
                      />
                    </label>
                    <div className="jp-NitroJudgeContestSearchActions">
                      <button
                        className="jp-NitroJudgeActionButton"
                        disabled={!this._taskQuery || this._busy}
                        onClick={() => {
                          this._taskQuery = '';
                          this.update();
                        }}
                        type="button"
                      >
                        Clear
                      </button>
                    </div>
                  </div>

                  <div className="jp-NitroJudgeTaskFinderMeta">
                    <p className="jp-NitroJudgeMuted">
                      Showing {this._selectedContest ? filteredTasks.length : 0} out of{' '}
                      {this._selectedContest ? visibleTaskCount : 0} tasks.
                    </p>
                  </div>

                  <div className="jp-NitroJudgeTaskList" aria-label="Task search results" role="listbox">
                    {this._selectedContest ? (
                      filteredTasks.length ? (
                        filteredTasks.map(task => {
                          const isSelected = this._selectedTask?.id === task.id;
                          return (
                            <button
                              aria-selected={isSelected}
                              className="jp-NitroJudgeTaskItem"
                              data-selected={isSelected}
                              key={task.id}
                              title={`${taskDisplayLabel(task)} (${task.id})`}
                              onClick={() => void this._selectTask(task.id)}
                              role="option"
                              type="button"
                            >
                              <span className="jp-NitroJudgeTaskItemMain">
                                <strong>
                                  {task.id}: {taskDisplayLabel(task)}
                                </strong>
                                <span className="jp-NitroJudgeMuted">{task.synopsis || 'No synopsis provided.'}</span>
                              </span>
                              <span className="jp-NitroJudgeContestBadge" data-state={isSelected ? 'running' : 'idle'}>
                                {isSelected ? 'Selected' : 'Task'}
                              </span>
                            </button>
                          );
                        })
                      ) : (
                        <p className="jp-NitroJudgeContestEmpty">No tasks match that search.</p>
                      )
                    ) : (
                      <div className="jp-NitroJudgeContestEmpty jp-NitroJudgeTaskEmptyBox" aria-hidden="true" />
                    )}
                  </div>
                </div>

                <fieldset className="jp-NitroJudgeSourceGroup jp-NitroJudgeTaskDataGroup">
                  <legend className="jp-NitroJudgeFieldTitle">Task data</legend>
                  <div className="jp-NitroJudgeDataGrid">
                    {this._dataOptions.map(category => (
                      <label className="jp-NitroJudgeCheckbox" data-available={category.available} key={category.value}>
                        <input
                          checked={this._dataCategories.includes(category.value)}
                          disabled={this._busy || !category.available}
                          onChange={event => this._toggleDataCategory(category.value, event.currentTarget.checked)}
                          type="checkbox"
                        />
                        <span className="jp-NitroJudgeCheckboxBox" aria-hidden="true" />
                        <span className="jp-NitroJudgeCheckboxLabel">{category.label}</span>
                      </label>
                    ))}
                  </div>
                  <div className="jp-NitroJudgeRow jp-NitroJudgeDataTarget">
                    <input
                      className="jp-NitroJudgeTaskDataInput"
                      onChange={event => {
                        this._dataOutputDir = event.currentTarget.value;
                        this.update();
                      }}
                      placeholder="Folder for downloaded task data"
                      type="text"
                      value={this._dataOutputDir}
                    />
                    <button
                      className="jp-NitroJudgeActionButton jp-NitroJudgeActionButtonPrimary"
                      disabled={this._busy || !this._canDownloadData()}
                      onClick={() => void this._downloadData()}
                      type="button"
                    >
                      Download
                    </button>
                  </div>
                </fieldset>
              </div>

              <div className="jp-NitroJudgeSubmissionNote">
                <label className="jp-NitroJudgeFieldLabel">
                  <span className="jp-NitroJudgeFieldTitle">Note</span>
                  <textarea
                    onChange={event => {
                      this._note = event.currentTarget.value;
                      this.update();
                    }}
                    placeholder="Optional note"
                    rows={3}
                    value={this._note}
                  />
                </label>
              </div>

              <div className="jp-NitroJudgeSubmissionBottom">
                <fieldset className="jp-NitroJudgeSourceGroup">
                  <legend className="jp-NitroJudgeFieldTitle">Source code</legend>
                  <label className="jp-NitroJudgeFieldLabel">
                    <div className="jp-NitroJudgeRow">
                      <input
                        onChange={event => {
                          const nextPath = event.currentTarget.value;
                          this._sourcePath = nextPath;
                          const nextKind = sourceSelectionKind(nextPath);
                          this._sourceMode = nextKind === 'source' ? 'file' : 'notebook';
                          if (nextKind !== 'source') {
                            this._useSubmissionProxy = false;
                          }
                          this.update();
                        }}
                        placeholder="Current notebook or choose a .py / .ipynb file"
                        type="text"
                        value={this._sourcePath}
                      />
                      <button
                        className="jp-NitroJudgeActionButton jp-NitroJudgeBrowseButton"
                        disabled={this._busy}
                        onClick={() => void this._pickSource()}
                        type="button"
                      >
                        Browse
                      </button>
                    </div>
                    <p className="jp-NitroJudgeMuted">{sourceLabel}</p>
                  </label>

                  {this._sourcePath.toLowerCase().endsWith('.py') ? (
                    <div className="jp-NitroJudgeProxyBlock">
                      <label className="jp-NitroJudgeCheckbox jp-NitroJudgeProxyToggle">
                        <input
                          checked={this._useSubmissionProxy}
                          disabled={this._busy || sourceSelectionKind(this._sourcePath) !== 'source'}
                          onChange={event => {
                            this._useSubmissionProxy = event.currentTarget.checked;
                            this.update();
                          }}
                          type="checkbox"
                        />
                        <span className="jp-NitroJudgeCheckboxBox" aria-hidden="true" />
                        <span className="jp-NitroJudgeCheckboxText">
                          Use submission proxy for interactive/pre-judging tasks
                        </span>
                      </label>
                    </div>
                  ) : null}
                </fieldset>

                <label className="jp-NitroJudgeFieldLabel">
                  <span className="jp-NitroJudgeFieldTitle">Output file</span>
                  <div className="jp-NitroJudgeRow">
                    <input
                      onChange={event => {
                        this._outputPath = event.currentTarget.value;
                        this.update();
                      }}
                      placeholder="path/to/output.csv or path/to/output.pkl"
                      type="text"
                      value={this._outputPath}
                    />
                    <button
                      className="jp-NitroJudgeActionButton jp-NitroJudgeBrowseButton"
                      disabled={this._busy}
                      onClick={() => void this._pickOutput()}
                      type="button"
                    >
                      Browse
                    </button>
                  </div>
                </label>
              </div>
            </div>
            <div className="jp-NitroJudgeSubmissionSubmit">
              <button
                className="jp-NitroJudgeActionButton jp-NitroJudgeActionButtonPrimary"
                disabled={this._busy || !this._canSubmit()}
                onClick={() => void this._submit()}
                type="button"
              >
                Submit
              </button>
            </div>
          </div>
        </section>

        {this._result ? (
          <section>
            <div className="jp-NitroJudgeSectionHeader">
              <h3>Feedback</h3>
            </div>
            <div className="jp-NitroJudgeSectionBody">
              <div className="jp-NitroJudgeSummary">
                <div className="jp-NitroJudgeStat">
                  Submission
                  <strong>{this._result.id}</strong>
                </div>
                <div className="jp-NitroJudgeStat">
                  State
                  <strong>{this._result.state}</strong>
                </div>
                <div className="jp-NitroJudgeStat">
                  Partial total
                  <strong>{this._displayValue(this._result.partialScore)}</strong>
                </div>
                <div className="jp-NitroJudgeStat">
                  Complete total
                  <strong>{this._displayValue(this._result.completeScore)}</strong>
                </div>
              </div>

              {this._result.prejudgingScriptOutput ? (
                <>
                  <h3 className="jp-NitroJudgeSubheading">Pre-judging script output</h3>
                  <pre className="jp-NitroJudgePrejudgeOutput">{this._result.prejudgingScriptOutput}</pre>
                </>
              ) : null}

              <h3 className="jp-NitroJudgeSubheading">Subtasks</h3>
              <div className="jp-NitroJudgeTableWrap">
                <table className="jp-NitroJudgeTable">
                  <thead>
                    <tr>
                      <th>Subtask</th>
                      <th>Max</th>
                      <th>Partial score</th>
                      <th>Partial metric</th>
                      <th>Complete score</th>
                      <th>Complete metric</th>
                    </tr>
                  </thead>
                  <tbody>
                    {this._result.subtasks.map(subtask => (
                      <tr key={String(subtask.id)}>
                        <td>
                          <strong>{subtask.title}</strong>
                          <div className="jp-NitroJudgeMuted">#{subtask.id}</div>
                        </td>
                        <td>{this._displayValue(subtask.maxScore)}</td>
                        <td>{this._displayValue(subtask.partialScore)}</td>
                        <td>
                          {subtask.metricName}: {this._displayValue(subtask.partialMetric)}
                        </td>
                        <td>{this._displayValue(subtask.completeScore)}</td>
                        <td>
                          {subtask.metricName}: {this._displayValue(subtask.completeMetric)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        ) : null}

        {pickerState ? (
          <div className="jp-NitroJudgeOverlay" role="dialog" aria-modal="true" aria-label={pickerState.title}>
            <div className="jp-NitroJudgeOverlayCard">
              <div className="jp-NitroJudgeOverlayHeader">
                <h3>{pickerState.title}</h3>
              </div>
              <p className="jp-NitroJudgeMuted">Current path: {pickerState.currentPath || '/'}</p>
              {pickerState.error ? (
                <div className="jp-NitroJudgeMessage" data-kind="error">
                  {pickerState.error}
                </div>
              ) : null}
              {pickerState.loading ? (
                <div className="jp-NitroJudgeMessage" data-kind="info">
                  Loading files...
                </div>
              ) : null}
              <div className="jp-NitroJudgePickerList">
                {pickerState.currentPath ? (
                  <button className="jp-NitroJudgePickerItem jp-NitroJudgePickerNav" onClick={() => void this._goUpPicker()} type="button">
                    ../
                  </button>
                ) : null}
                {!pickerState.loading && pickerState.entries.length === 0 ? (
                  <p className="jp-NitroJudgeMuted">{pickerState.emptyMessage}</p>
                ) : null}
                {pickerState.entries.map(item => {
                  const isSelected = item.path === pickerState.selectedPath;
                  return (
                    <button
                      key={item.path}
                      className="jp-NitroJudgePickerItem"
                      data-selected={isSelected}
                      onClick={() => void this._handlePickerItem(item)}
                      type="button"
                    >
                      {item.type === 'directory' ? `${item.name}/` : item.name}
                    </button>
                  );
                })}
              </div>
              <div className="jp-NitroJudgeActions">
                <button className="jp-NitroJudgeActionButton" onClick={() => this._closePicker()} type="button">
                  Close
                </button>
                <button
                  className="jp-NitroJudgeActionButton jp-NitroJudgeActionButtonPrimary"
                  disabled={pickerState.loading || pickerState.selectedType !== 'file'}
                  onClick={() => this._confirmPicker()}
                  type="button"
                >
                  Select
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  private _canSubmit(): boolean {
    if (
      !this._status.loggedIn ||
      !this._selectedContest ||
      !this._selectedTask ||
      !this._outputPath
    ) {
      return false;
    }
    const sourceKind = this._sourcePath ? sourceSelectionKind(this._sourcePath) : 'notebook';
    if (!sourceKind) {
      return false;
    }
    if (this._useSubmissionProxy && sourceKind !== 'source') {
      return false;
    }
    return true;
  }

  private _canDownloadData(): boolean {
    return (
      this._status.loggedIn &&
      Boolean(this._selectedContest) &&
      Boolean(this._selectedTask) &&
      this._dataCategories.some(category => this._isDataCategoryAvailable(category))
    );
  }

  private _toggleDataCategory(category: TaskDataCategory, enabled: boolean): void {
    if (!this._isDataCategoryAvailable(category)) {
      return;
    }
    if (enabled) {
      this._dataCategories = Array.from(new Set([...this._dataCategories, category]));
    } else {
      this._dataCategories = this._dataCategories.filter(item => item !== category);
    }
    this.update();
  }

  private _isDataCategoryAvailable(category: TaskDataCategory): boolean {
    return this._dataOptions.some(item => item.value === category && item.available);
  }

  private _displayValue(value: string | number | null | undefined): string {
    return value === null || value === undefined || value === '' ? '-' : String(value);
  }

  private _currentNotebookPanel(): NotebookPanel {
    const current = this._app.shell.currentWidget;
    if (current instanceof NotebookPanel) {
      return current;
    }

    return this._panel;
  }

  private _normalizeStatus(status: LoginStatus): LoginStatus {
    return {
      ...status,
      loggedIn: Boolean(status.loggedIn || status.authenticated),
      username: status.username ?? null
    };
  }

  private _isAuthError(message: string): boolean {
    return message.includes('login expired') || message.includes('Not logged in');
  }

  private _resetLogin(): void {
    const username = this._status.username;
    this._status = { loggedIn: false, username: null };
    this._contests = [];
    this._tasks = [];
    this._contestQuery = '';
    this._taskQuery = '';
    this._selectedContest = null;
    this._selectedTask = null;
    contestCache = null;
    taskCache.clear();
    clearPanelCache(username);
  }

  private _restorePanelCache(): boolean {
    const cache = readPanelCache(this._status.username);
    if (!cache) {
      return false;
    }

    this._contests = visibleContests(cache.contests);
    contestCache = this._contests;
    taskCache.clear();
    for (const [key, tasks] of Object.entries(cache.tasks)) {
      if (Array.isArray(tasks)) {
        taskCache.set(key, tasks);
      }
    }
    this.update();
    return true;
  }

  private _savePanelCache(): void {
    writePanelCache(this._status.username, this._contests, taskCache);
  }

  private _filteredContests(): Contest[] {
    const contests = visibleContests(this._contests).slice();
    const terms = this._contestQuery
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    const scoreContest = (contest: Contest): number => {
      if (terms.length === 0) {
        return 0;
      }

      const text = contestSearchText(contest);
      if (!terms.every(term => text.includes(term))) {
        return Number.POSITIVE_INFINITY;
      }

      const display = contestDisplayLabel(contest).toLowerCase();
      const slug = contest.slug.toLowerCase();
      const org = contest.org.toLowerCase();
      const full = `${org}/${slug}`;
      const query = terms.join(' ');
      let score = contest.isRunning ? 0 : 100;
      if (
        this._selectedContest &&
        this._selectedContest.org === contest.org &&
        this._selectedContest.slug === contest.slug
      ) {
        score -= 25;
      }

      if (full === query || display === query) {
        score -= 20;
      } else if (full.startsWith(query) || display.startsWith(query) || slug.startsWith(query)) {
        score -= 10;
      } else if (text.includes(query)) {
        score -= 2;
      }

      score += display.length / 100;
      return score;
    };

    return contests.sort((a, b) => {
      const scoreA = scoreContest(a);
      const scoreB = scoreContest(b);
      if (scoreA !== scoreB) {
        return scoreA - scoreB;
      }

      const dateA = contestDateValue(a);
      const dateB = contestDateValue(b);
      if (dateA !== dateB) {
        return dateB - dateA;
      }

      if (a.isRunning !== b.isRunning) {
        return a.isRunning ? -1 : 1;
      }

      return a.org.localeCompare(b.org) || a.slug.localeCompare(b.slug);
    });
  }

  private _filteredTasks(): Task[] {
    const tasks = this._tasks.slice();
    const terms = this._taskQuery
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    const scoreTask = (task: Task): number => {
      if (terms.length === 0) {
        return 0;
      }

      const text = taskSearchText(task);
      if (!terms.every(term => text.includes(term))) {
        return Number.POSITIVE_INFINITY;
      }

      const display = taskDisplayLabel(task).toLowerCase();
      const id = task.id.toLowerCase();
      const synopsis = task.synopsis.toLowerCase();
      const query = terms.join(' ');
      let score = 0;

      if (this._selectedTask && this._selectedTask.id === task.id) {
        score -= 25;
      }

      if (id === query || display === query) {
        score -= 20;
      } else if (id.startsWith(query) || display.startsWith(query) || synopsis.startsWith(query)) {
        score -= 10;
      } else if (text.includes(query)) {
        score -= 2;
      }

      score += display.length / 100;
      return score;
    };

    return tasks.sort((a, b) => {
      const scoreA = scoreTask(a);
      const scoreB = scoreTask(b);
      if (scoreA !== scoreB) {
        return scoreA - scoreB;
      }

      return a.id.localeCompare(b.id);
    });
  }

  private _taskCacheKey(contest: Contest): string {
    return `${contest.org}/${contest.slug}`;
  }

  private async _prefetchTasks(): Promise<void> {
    const contests = visibleContests(this._contests).filter(
      contest => !taskCache.has(this._taskCacheKey(contest))
    );
    const batchSize = 4;
    for (let index = 0; index < contests.length; index += batchSize) {
      const batch = contests.slice(index, index + batchSize);
      await Promise.allSettled(
        batch.map(async contest => {
          const cacheKey = this._taskCacheKey(contest);
          const response = await requestAPI<{ items: Task[] }>(
            `tasks?org=${encodeURIComponent(contest.org)}&comp=${encodeURIComponent(contest.slug)}`
          );
          taskCache.set(cacheKey, response.items);
        })
      );
      this._savePanelCache();
    }
  }

  private async _initialize(): Promise<void> {
    await this._setBusy('Checking Nitro AI Judge login...');
    try {
      this._status = this._normalizeStatus(await requestAPI<LoginStatus>('status'));
      if (this._status.loggedIn) {
        await this._loadContests();
      }
    } catch (error) {
      this._error = this._asMessage(error);
      if (this._isAuthError(this._error)) {
        this._resetLogin();
      }
    } finally {
      this._clearBusy();
    }
  }

  private async _login(): Promise<void> {
    await this._setBusy('Logging in to Nitro AI Judge...');
    this._error = null;

    try {
      this._status = this._normalizeStatus(await requestAPI<LoginStatus>('login', {
        body: JSON.stringify({ username: this._username, password: this._password }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST'
      }));
      this._password = '';
      await this._loadContests({ force: true });
    } catch (error) {
      this._error = this._asMessage(error);
      if (this._isAuthError(this._error)) {
        this._resetLogin();
      }
    } finally {
      this._clearBusy();
    }
  }

  private async _loadContests(options: { force?: boolean } = {}): Promise<void> {
    if (!options.force && contestCache) {
      this._contests = contestCache;
      if (this._selectedContest) {
        const refreshed = this._contests.find(
          item => item.org === this._selectedContest?.org && item.slug === this._selectedContest?.slug
        );
        this._selectedContest = refreshed ?? null;
        if (this._selectedContest) {
          await this._selectContest(`${this._selectedContest.org}/${this._selectedContest.slug}`);
          return;
        }
      }
      this.update();
      return;
    }

    if (!options.force && this._restorePanelCache()) {
      void this._prefetchTasks();
      return;
    }

    await this._setBusy('Loading contests...');
    this._error = null;

    try {
      const endpoint = options.force ? 'contests?force=true' : 'contests';
      const response = await requestAPI<{ items: Contest[] }>(endpoint);
      this._contests = visibleContests(response.items);
      contestCache = this._contests;
      this._savePanelCache();
      void this._prefetchTasks();
      if (this._selectedContest) {
        const refreshed = this._contests.find(
          item => item.org === this._selectedContest?.org && item.slug === this._selectedContest?.slug
        );
        this._selectedContest = refreshed ?? null;
        if (this._selectedContest) {
          await this._selectContest(`${this._selectedContest.org}/${this._selectedContest.slug}`);
        } else {
          this._selectedTask = null;
          this._tasks = [];
          this._taskQuery = '';
          this._dataOptions = TASK_DATA_CATEGORIES.map(item => ({ ...item, available: false }));
          this._dataCategories = [];
          this._result = null;
        }
      }
    } catch (error) {
      this._error = this._asMessage(error);
      if (this._isAuthError(this._error)) {
        this._resetLogin();
      }
    } finally {
      this._clearBusy();
    }
  }

  private async _selectContest(value: string): Promise<void> {
    this._selectedTask = null;
    this._tasks = [];
    this._taskQuery = '';
    this._dataOptions = TASK_DATA_CATEGORIES.map(item => ({ ...item, available: false }));
    this._dataCategories = [];
    this._result = null;

    if (!value) {
      this._selectedContest = null;
      this.update();
      return;
    }

    const selected = this._contests.find(item => `${item.org}/${item.slug}` === value) ?? null;
    if (selected && !canSelectContest(selected)) {
      this._selectedContest = null;
      this.update();
      return;
    }
    this._selectedContest = selected;
    if (!selected) {
      this.update();
      return;
    }

    const cacheKey = this._taskCacheKey(selected);
    const cachedTasks = taskCache.get(cacheKey);
    if (cachedTasks) {
      this._tasks = cachedTasks;
      this.update();
      return;
    }

    const contestLabel = selected.title || `${selected.org}/${selected.slug}`;
    await this._setBusy(`Loading tasks for ${contestLabel}...`);
    this._error = null;

    try {
      const response = await requestAPI<{ items: Task[] }>(
        `tasks?org=${encodeURIComponent(selected.org)}&comp=${encodeURIComponent(selected.slug)}`
      );
      this._tasks = response.items;
      if (this._selectedTask) {
        this._selectedTask = this._tasks.find(item => item.id === this._selectedTask?.id) ?? null;
      }
      taskCache.set(cacheKey, response.items);
      this._savePanelCache();
    } catch (error) {
      this._error = this._asMessage(error);
    } finally {
      this._clearBusy();
    }
  }

  private async _selectTask(value: string): Promise<void> {
    this._dataOptions = TASK_DATA_CATEGORIES.map(item => ({ ...item, available: false }));
    this._dataCategories = [];
    this._result = null;

    if (!value) {
      this._selectedTask = null;
      this.update();
      return;
    }

    const selected = this._tasks.find(item => item.id === value) ?? null;
    this._selectedTask = selected;

    if (!selected) {
      this.update();
      return;
    }

    await this._loadTaskDataOptions(selected.id);
  }

  private async _loadTaskDataOptions(taskId: string): Promise<void> {
    if (!this._selectedContest) {
      return;
    }

    try {
      const response = await requestAPI<{ items: Array<{ category: string; label: string; available: boolean }> }>(
        `task-data-options?org=${encodeURIComponent(this._selectedContest.org)}&comp=${encodeURIComponent(this._selectedContest.slug)}&taskId=${encodeURIComponent(taskId)}`
      );
      this._dataOptions = TASK_DATA_CATEGORIES.map(category => {
        const option = response.items.find(item => normalizeTaskDataCategory(item.category, item.label) === category.value);
        return {
          ...category,
          label: option?.label ?? category.label,
          available: Boolean(option?.available)
        };
      });
      this._dataCategories = this._dataOptions.filter(item => item.available).map(item => item.value);
    } catch (error) {
      this._error = this._asMessage(error);
      this._dataOptions = TASK_DATA_CATEGORIES.map(item => ({ ...item, available: false }));
      this._dataCategories = [];
    } finally {
      this.update();
    }
  }

  private async _pickOutput(): Promise<void> {
    try {
      const selected = await this._openPicker('Pick output file', {
        emptyMessage: 'No files in this folder. You can still open another folder or go up.'
      });
      if (selected) {
        this._outputPath = selected;
        this.update();
      }
    } catch (error) {
      this._error = this._asMessage(error);
      this.update();
    }
  }

  private async _pickSource(): Promise<void> {
    try {
      const selected = await this._openPicker('Pick source file', {
        acceptFile: item => {
          const lower = item.name.toLowerCase();
          return lower.endsWith('.py') || lower.endsWith('.ipynb');
        },
        emptyMessage: 'No Python or notebook files in this folder. You can still open another folder or go up.'
      });
      if (selected) {
        this._sourcePath = selected;
        const nextKind = sourceSelectionKind(selected);
        this._sourceMode = nextKind === 'source' ? 'file' : 'notebook';
        if (nextKind !== 'source') {
          this._useSubmissionProxy = false;
        }
        this.update();
      }
    } catch (error) {
      this._error = this._asMessage(error);
      this.update();
    }
  }

  private async _submit(): Promise<void> {
    if (!this._selectedContest || !this._selectedTask) {
      return;
    }

    const currentNotebook = this._currentNotebookPanel();

    await this._setBusy('Submitting to Nitro AI Judge and waiting for feedback...');
    this._error = null;
    this._result = null;

    try {
      const payload: Record<string, unknown> = {
        org: this._selectedContest.org,
        comp: this._selectedContest.slug,
        taskId: this._selectedTask.id,
        outputPath: this._outputPath,
        note: this._note,
        sourceMode: this._sourceMode,
        submissionProxy: this._useSubmissionProxy
      };

      const sourceKind = this._sourcePath ? sourceSelectionKind(this._sourcePath) : 'notebook';
      if (sourceKind === 'source') {
        payload.sourcePath = this._sourcePath;
      } else {
        const notebookPath = this._sourcePath || currentNotebook.context.path;
        if (this._sourcePath) {
          const sourceModel = await this._app.serviceManager.contents.get(this._sourcePath, { content: true });
          payload.sourceContent = notebookSourceContentFromModel(sourceModel);
          payload.sourceFilename = notebookSourceFilenameFromPath(notebookPath);
        } else {
          payload.sourceContent = notebookSourceContent(currentNotebook);
          payload.sourceFilename = notebookSourceFilename(currentNotebook);
        }
      }

      const response = await requestAPI<{
        submission: SubmissionResult;
      }>('submit', {
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST'
      });
      this._result = response.submission;
    } catch (error) {
      this._error = this._asMessage(error);
    } finally {
      this._clearBusy();
    }
  }

  private async _downloadData(): Promise<void> {
    if (!this._selectedContest || !this._selectedTask) {
      return;
    }

    await this._setBusy('Downloading task data...');
    this._error = null;

    try {
      await requestAPI('download-data', {
        body: JSON.stringify({
          org: this._selectedContest.org,
          comp: this._selectedContest.slug,
          taskId: this._selectedTask.id,
          categories: this._dataCategories.filter(category => this._isDataCategoryAvailable(category)),
          outputDir: this._dataOutputDir,
          force: true
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST'
      });
    } catch (error) {
      this._error = this._asMessage(error);
    } finally {
      this._clearBusy();
    }
  }

  private _asMessage(error: unknown): string {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return String(error);
  }

  private async _setBusy(message: string): Promise<void> {
    this._busy = true;
    this._busyMessage = message;
    this.update();
    await Promise.resolve();
  }

  private _clearBusy(): void {
    this._busy = false;
    this._busyMessage = null;
    this.update();
  }

  private async _openPicker(title: string, options: FilePickerOptions = {}): Promise<string | null> {
    if (this._pickerResolver) {
      this._pickerResolver(null);
    }

    const promise = new Promise<string | null>(resolve => {
      this._pickerResolver = resolve;
    });

    this._pickerState = {
      acceptFile: options.acceptFile,
      currentPath: notebookDirectory(this._currentNotebookPanel()),
      emptyMessage: options.emptyMessage ?? 'No matching files in this folder.',
      entries: [],
      error: null,
      loading: true,
      selectedPath: null,
      selectedType: null,
      title
    };
    this.update();
    await this._loadPickerDirectory(this._pickerState.currentPath);
    return promise;
  }

  private async _loadPickerDirectory(path: string): Promise<void> {
    if (!this._pickerState) {
      return;
    }

    this._pickerState = {
      ...this._pickerState,
      currentPath: path,
      error: null,
      loading: true,
      selectedPath: null,
      selectedType: null
    };
    this.update();

    try {
      const model = await this._app.serviceManager.contents.get(path, { content: true });
      if (model.type !== 'directory') {
        throw new Error(`Path is not a directory: ${path}`);
      }

      const entries = ((model.content as Contents.IModel[]) ?? [])
        .filter(item => item.type === 'directory' || !this._pickerState?.acceptFile || this._pickerState.acceptFile(item))
        .map(item => ({ name: item.name, path: item.path, type: item.type }))
        .sort((a, b) => {
          if (a.type !== b.type) {
            return a.type === 'directory' ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        });

      if (!this._pickerState) {
        return;
      }

      this._pickerState = {
        ...this._pickerState,
        currentPath: path,
        entries,
        loading: false
      };
    } catch (error) {
      if (!this._pickerState) {
        return;
      }

      this._pickerState = {
        ...this._pickerState,
        currentPath: path,
        entries: [],
        error: this._asMessage(error),
        loading: false
      };
    }

    this.update();
  }

  private async _handlePickerItem(item: PickerEntry): Promise<void> {
    if (!this._pickerState) {
      return;
    }

    if (item.type === 'directory') {
      await this._loadPickerDirectory(item.path);
      return;
    }

    this._pickerState = {
      ...this._pickerState,
      selectedPath: item.path,
      selectedType: item.type
    };
    this.update();
  }

  private async _goUpPicker(): Promise<void> {
    if (!this._pickerState || !this._pickerState.currentPath) {
      return;
    }

    const parentPath = PathExt.dirname(this._pickerState.currentPath);
    await this._loadPickerDirectory(parentPath === '.' ? '' : parentPath);
  }

  private _confirmPicker(): void {
    if (!this._pickerState || this._pickerState.selectedType !== 'file' || !this._pickerState.selectedPath) {
      return;
    }

    const selectedPath = this._pickerState.selectedPath;
    const resolve = this._pickerResolver;
    this._pickerState = null;
    this._pickerResolver = null;
    this.update();
    resolve?.(selectedPath);
  }

  private _closePicker(): void {
    const resolve = this._pickerResolver;
    this._pickerState = null;
    this._pickerResolver = null;
    this.update();
    resolve?.(null);
  }

  private _app: JupyterFrontEnd;
  private _panel: NotebookPanel;
  private _initialized = false;
  private _status: LoginStatus = { loggedIn: false, username: null };
  private _username = '';
  private _password = '';
  private _contests: Contest[] = [];
  private _contestQuery = '';
  private _taskQuery = '';
  private _tasks: Task[] = [];
  private _selectedContest: Contest | null = null;
  private _selectedTask: Task | null = null;
  private _outputPath = '';
  private _dataOutputDir = '';
  private _dataOptions: TaskDataOption[] = TASK_DATA_CATEGORIES.map(item => ({ ...item, available: false }));
  private _dataCategories: TaskDataCategory[] = [];
  private _sourceMode: SourceMode = 'notebook';
  private _sourcePath = '';
  private _useSubmissionProxy = false;
  private _note = '';
  private _busy = false;
  private _busyMessage: string | null = null;
  private _error: string | null = null;
  private _pickerResolver: ((value: string | null) => void) | null = null;
  private _pickerState: PickerState | null = null;
  private _result: SubmissionResult | null = null;
}

function judgePanelId(notebook: NotebookPanel): string {
  return `nitro-ai-judge:${notebook.context.path}`;
}

function createJudgePanel(app: JupyterFrontEnd, notebook: NotebookPanel): MainAreaWidget<NitroJudgeBody> {
  const content = new NitroJudgeBody(app, notebook);
  const widget = new MainAreaWidget({ content });
  widget.id = judgePanelId(notebook);
  widget.title.label = `Nitro AI Judge: ${PathExt.basename(notebook.context.path)}`;
  widget.title.icon = nitroJudgeIcon;
  widget.title.closable = true;
  return widget;
}

function openJudgePanel(app: JupyterFrontEnd, notebook: NotebookPanel): void {
  const id = judgePanelId(notebook);

  for (const widget of app.shell.widgets('main')) {
    if (widget.id === id) {
      app.shell.activateById(id);
      return;
    }
  }

  const widget = createJudgePanel(app, notebook);
  app.shell.add(widget, 'main');
  app.shell.activateById(widget.id);
}

const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab-nitro-ai-judge:plugin',
  autoStart: true,
  requires: [INotebookTracker],
  activate: (app: JupyterFrontEnd, tracker: INotebookTracker) => {
    tracker.widgetAdded.connect((_sender, notebook) => {
      notebook.toolbar.insertAfter(
        'cellType',
        'nitro-ai-judge-submit',
        new ToolbarButton({
          className: 'jp-NitroJudgeToolbarButton',
          icon: nitroJudgeIcon,
          label: 'Nitro AI Judge',
          onClick: () => {
            openJudgePanel(app, notebook);
          },
          tooltip: 'Nitro AI Judge'
        })
      );
    });
  }
};

export default plugin;
