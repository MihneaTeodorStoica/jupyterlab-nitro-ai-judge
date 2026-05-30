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
};

type Contest = {
  org: string;
  slug: string;
  title: string;
  competitionStart: number | null;
  hasStarted: boolean;
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

type TaskDataDownload = {
  category: TaskDataCategory;
  path: string;
  bytes: number;
};

type TaskDataOption = {
  value: TaskDataCategory;
  label: string;
  available: boolean;
};

const TASK_DATA_CATEGORIES: Array<{ value: TaskDataCategory; label: string }> = [
  { value: 'statement', label: 'Statement' },
  { value: 'train_data', label: 'Train data' },
  { value: 'test_data', label: 'Test data' },
  { value: 'sample_output', label: 'Sample output' },
  { value: 'custom_archive', label: 'Starter kit' },
  { value: 'pre_judging_script', label: 'Pre-judging script' }
];

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

function formatContestLabel(contest: Contest): string {
  const value = contest.title || `${contest.org}/${contest.slug}`;
  return contest.hasStarted ? value : `${value} (not started yet)`;
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
    const selectedContestValue = this._selectedContest
      ? `${this._selectedContest.org}/${this._selectedContest.slug}`
      : '';
    const currentNotebook = this._currentNotebookPanel();
    const pickerState = this._pickerState;

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
          {this._status.loggedIn ? (
            <p className="jp-NitroJudgeStatusLine">
              Logged in as <strong>{this._status.username}</strong>.
            </p>
          ) : (
            <div className="jp-NitroJudgeGrid">
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
              <div className="jp-NitroJudgeActions">
                <button disabled={this._busy} onClick={() => void this._login()} type="button">
                  Log in
                </button>
              </div>
            </div>
          )}
        </section>

        <section>
          <div className="jp-NitroJudgeSectionHeader">
            <h3>Submission</h3>
            <p className="jp-NitroJudgeMuted">Choose the task, output file, and source to submit.</p>
          </div>
          <div className="jp-NitroJudgeGrid">
            <label className="jp-NitroJudgeFieldLabel">
              <span className="jp-NitroJudgeFieldTitle">Contest</span>
              <select
                disabled={!this._status.loggedIn || this._busy}
                onChange={event => void this._selectContest(event.currentTarget.value)}
                value={selectedContestValue}
              >
                <option value="">Select a contest</option>
                {this._contests.map(contest => {
                  const value = `${contest.org}/${contest.slug}`;
                  return (
                    <option disabled={!contest.hasStarted} key={value} value={value}>
                      {formatContestLabel(contest)}
                    </option>
                  );
                })}
              </select>
              <p className="jp-NitroJudgeMuted">Upcoming contests are shown but unavailable until they start.</p>
            </label>

            <label className="jp-NitroJudgeFieldLabel">
              <span className="jp-NitroJudgeFieldTitle">Task</span>
              <select
                disabled={!this._selectedContest || this._busy}
                onChange={event => {
                  const task = this._tasks.find(item => item.id === event.currentTarget.value) ?? null;
                  this._selectedTask = task;
                  this._dataOptions = TASK_DATA_CATEGORIES.map(item => ({ ...item, available: false }));
                  this._downloadedData = [];
                  this._result = null;
                  this._submissionHistory = [];
                  this._submissionCount = null;
                  this.update();
                  if (task) {
                    void this._loadTaskDataOptions(task.id);
                    void this._loadSubmissionHistory(task.id);
                  }
                }}
                value={this._selectedTask?.id ?? ''}
              >
                <option value="">Select a task</option>
                {this._tasks.map(task => (
                  <option key={task.id} value={task.id}>
                    {task.id}: {task.title}
                  </option>
                ))}
              </select>
            </label>

            <fieldset className="jp-NitroJudgeSourceGroup">
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
              {this._downloadedData.length ? (
                <ul className="jp-NitroJudgeDownloadList">
                  {this._downloadedData.map(item => (
                    <li key={`${item.category}:${item.path}`}>
                      <strong>{this._dataCategoryLabel(item.category)}</strong>: {item.path}
                    </li>
                  ))}
                </ul>
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
                  className="jp-NitroJudgeBrowseButton"
                  disabled={this._busy}
                  onClick={() => void this._pickOutput()}
                  type="button"
                >
                  Browse
                </button>
              </div>
              <p className="jp-NitroJudgeMuted">Choose any output file from the notebook folder tree.</p>
            </label>

            <label className="jp-NitroJudgeCheckbox jp-NitroJudgeProxyToggle">
              <input
                checked={this._useSubmissionProxy}
                onChange={event => {
                  this._useSubmissionProxy = event.currentTarget.checked;
                  if (this._useSubmissionProxy) {
                    this._sourceMode = 'file';
                  }
                  this.update();
                }}
                type="checkbox"
              />
              <span className="jp-NitroJudgeCheckboxText">Use submission proxy for interactive/pre-judging tasks</span>
            </label>
            <p className="jp-NitroJudgeMuted">
              Sends Jupyter file paths to the contest submission proxy so pre-judging scripts can run before upload.
              Requires a saved Python source file.
            </p>

            <fieldset className="jp-NitroJudgeSourceGroup">
              <legend className="jp-NitroJudgeFieldTitle">Source code</legend>
              <div className="jp-NitroJudgeRadioGroup" role="radiogroup" aria-label="Source code mode">
                <label className="jp-NitroJudgeSourceOption" data-selected={this._sourceMode === 'notebook'}>
                  <input
                    checked={this._sourceMode === 'notebook'}
                    name="nitro-source-mode"
                    onChange={() => {
                      this._sourceMode = 'notebook';
                      this._useSubmissionProxy = false;
                      this.update();
                    }}
                    type="radio"
                  />
                  <span>
                    <span className="jp-NitroJudgeSourceOptionTitle">Current notebook</span>
                    <span className="jp-NitroJudgeSourceOptionDetail">Export code cells as a temporary Python file.</span>
                  </span>
                </label>
                <label className="jp-NitroJudgeSourceOption" data-selected={this._sourceMode === 'file'}>
                  <input
                    checked={this._sourceMode === 'file'}
                    name="nitro-source-mode"
                    onChange={() => {
                      this._sourceMode = 'file';
                      this.update();
                    }}
                    type="radio"
                  />
                  <span>
                    <span className="jp-NitroJudgeSourceOptionTitle">Python source file</span>
                    <span className="jp-NitroJudgeSourceOptionDetail">Pick an existing `.py` file from the notebook folder tree.</span>
                  </span>
                </label>
              </div>
            </fieldset>

            <label className="jp-NitroJudgeFieldLabel">
              <span className="jp-NitroJudgeFieldTitle">Source file</span>
              {this._sourceMode === 'file' ? (
                <div className="jp-NitroJudgeRow">
                  <input
                    onChange={event => {
                      this._sourcePath = event.currentTarget.value;
                      this.update();
                    }}
                    placeholder="path/to/solution.py"
                    type="text"
                    value={this._sourcePath}
                  />
                  <button
              className="jp-NitroJudgeBrowseButton"
              disabled={this._busy}
              onClick={() => void this._pickSource()}
              type="button"
            >
                    Browse
                  </button>
                </div>
              ) : (
                <p className="jp-NitroJudgeMuted jp-NitroJudgeSourceHint">
                  The current notebook will be exported from code cells into a temporary Python file.
                </p>
              )}
            </label>

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

          <div className="jp-NitroJudgeActions">
            <button disabled={this._busy || !this._canSubmit()} onClick={() => void this._submit()} type="button">
              Submit and Wait for Feedback
            </button>
            <button
              disabled={this._busy || !this._status.loggedIn}
              onClick={() => void this._loadContests({ force: true })}
              type="button"
            >
              Refresh contests
            </button>
          </div>
        </section>

        {this._result ? (
          <section>
            <div className="jp-NitroJudgeSectionHeader">
              <h3>Feedback</h3>
            </div>
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
          </section>
        ) : null}

        {this._submissionHistory.length > 0 ? (
          <section className="jp-NitroJudgeResult jp-NitroJudgeHistory">
            <div className="jp-NitroJudgeSectionHeader">
              <h3>Submission history</h3>
              <p className="jp-NitroJudgeMuted">
                {this._submissionCount === null ? `${this._submissionHistory.length} recent submissions` : `${this._submissionCount} total submissions`}
              </p>
            </div>
            <div className="jp-NitroJudgeHistoryList">
              {this._submissionHistory.map((submission, index) => (
                <div className="jp-NitroJudgeHistoryItem" key={`${submission.id}-${index}`}>
                  <div>
                    <strong>{submission.state}</strong>
                    <p className="jp-NitroJudgeMuted">{this._submissionTime(submission.createdAt)}</p>
                  </div>
                  <div className="jp-NitroJudgeHistoryScores">
                    <span>Partial {this._displayValue(submission.partialScore)}</span>
                    <span>Complete {this._displayValue(submission.completeScore)}</span>
                  </div>
                </div>
              ))}
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
                <button onClick={() => this._closePicker()} type="button">
                  Close
                </button>
                <button
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
      !this._selectedContest.hasStarted ||
      !this._selectedTask ||
      !this._outputPath
    ) {
      return false;
    }
    if (this._sourceMode === 'file' && !this._sourcePath) {
      return false;
    }
    if (this._sourceMode === 'file' && !this._sourcePath.toLowerCase().endsWith('.py')) {
      return false;
    }
    if (this._useSubmissionProxy && this._sourceMode !== 'file') {
      return false;
    }
    return true;
  }

  private _canDownloadData(): boolean {
    return (
      this._status.loggedIn &&
      Boolean(this._selectedContest?.hasStarted) &&
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

  private _dataCategoryLabel(category: TaskDataCategory): string {
    return TASK_DATA_CATEGORIES.find(item => item.value === category)?.label ?? category;
  }

  private _isDataCategoryAvailable(category: TaskDataCategory): boolean {
    return this._dataOptions.some(item => item.value === category && item.available);
  }

  private _displayValue(value: string | number | null | undefined): string {
    return value === null || value === undefined || value === '' ? '-' : String(value);
  }

  private _submissionTime(value: string | null | undefined): string {
    if (!value) {
      return 'Unknown time';
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return value;
    }

    return parsed.toLocaleString();
  }

  private _currentNotebookPanel(): NotebookPanel {
    const current = this._app.shell.currentWidget;
    if (current instanceof NotebookPanel) {
      return current;
    }

    return this._panel;
  }

  private async _initialize(): Promise<void> {
    await this._setBusy('Checking Nitro AI Judge login...');
    try {
      this._status = await requestAPI<LoginStatus>('status');
      if (this._status.loggedIn) {
        await this._loadContests();
      }
    } catch (error) {
      this._error = this._asMessage(error);
    } finally {
      this._clearBusy();
    }
  }

  private async _login(): Promise<void> {
    await this._setBusy('Logging in to Nitro AI Judge...');
    this._error = null;

    try {
      this._status = await requestAPI<LoginStatus>('login', {
        body: JSON.stringify({ username: this._username, password: this._password }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST'
      });
      this._password = '';
      await this._loadContests({ force: true });
    } catch (error) {
      this._error = this._asMessage(error);
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

    await this._setBusy('Loading contests...');
    this._error = null;

    try {
      const response = await requestAPI<{ items: Contest[] }>('contests');
      this._contests = response.items;
      contestCache = response.items;
      taskCache.clear();
      if (this._selectedContest) {
        const refreshed = this._contests.find(
          item => item.org === this._selectedContest?.org && item.slug === this._selectedContest?.slug
        );
        this._selectedContest = refreshed ?? null;
        if (this._selectedContest) {
          await this._selectContest(`${this._selectedContest.org}/${this._selectedContest.slug}`);
        }
      }
    } catch (error) {
      this._error = this._asMessage(error);
    } finally {
      this._clearBusy();
    }
  }

  private async _selectContest(value: string): Promise<void> {
    this._selectedTask = null;
    this._tasks = [];
    this._dataOptions = TASK_DATA_CATEGORIES.map(item => ({ ...item, available: false }));
    this._dataCategories = [];
    this._downloadedData = [];
    this._result = null;
    this._submissionHistory = [];
    this._submissionCount = null;

    if (!value) {
      this._selectedContest = null;
      this.update();
      return;
    }

    const selected = this._contests.find(item => `${item.org}/${item.slug}` === value) ?? null;
    this._selectedContest = selected;

    if (!selected) {
      this.update();
      return;
    }

    const cacheKey = `${selected.org}/${selected.slug}`;
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
      taskCache.set(cacheKey, response.items);
    } catch (error) {
      this._error = this._asMessage(error);
    } finally {
      this._clearBusy();
    }
  }

  private async _loadTaskDataOptions(taskId: string): Promise<void> {
    if (!this._selectedContest) {
      return;
    }

    try {
      const response = await requestAPI<{ items: Array<{ category: TaskDataCategory; label: string; available: boolean }> }>(
        `task-data-options?org=${encodeURIComponent(this._selectedContest.org)}&comp=${encodeURIComponent(this._selectedContest.slug)}&taskId=${encodeURIComponent(taskId)}`
      );
      this._dataOptions = TASK_DATA_CATEGORIES.map(category => {
        const option = response.items.find(item => item.category === category.value);
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

  private async _loadSubmissionHistory(taskId: string): Promise<void> {
    if (!this._selectedContest) {
      return;
    }

    try {
      const response = await requestAPI<{ items: SubmissionResult[]; submissionCount?: number | string | null }>(
        `submission-history?org=${encodeURIComponent(this._selectedContest.org)}&comp=${encodeURIComponent(this._selectedContest.slug)}&taskId=${encodeURIComponent(taskId)}`
      );
      this._submissionHistory = response.items;
      this._submissionCount = response.submissionCount ?? this._submissionCount ?? response.items.length;
    } catch (error) {
      this._error = this._asMessage(error);
      this._submissionHistory = [];
      this._submissionCount = null;
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
        acceptFile: item => item.name.toLowerCase().endsWith('.py'),
        emptyMessage: 'No Python files in this folder. You can still open another folder or go up.'
      });
      if (selected) {
        this._sourcePath = selected;
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
        submissionProxy: this._useSubmissionProxy
      };

      if (this._sourceMode === 'file') {
        payload.sourcePath = this._sourcePath;
      } else {
        payload.notebookPath = currentNotebook.context.path;
      }

      const response = await requestAPI<{
        submission: SubmissionResult;
        submissionCount?: number | string | null;
      }>('submit', {
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST'
      });
      this._result = response.submission;
      this._submissionCount = response.submissionCount ?? this._submissionCount;
      this._submissionHistory = [
        response.submission,
        ...this._submissionHistory.filter(item => item.id !== response.submission.id)
      ];
      await this._loadSubmissionHistory(this._selectedTask.id);
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
    this._downloadedData = [];

    try {
      const response = await requestAPI<{ items: TaskDataDownload[] }>('download-data', {
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
      this._downloadedData = response.items;
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
  private _tasks: Task[] = [];
  private _selectedContest: Contest | null = null;
  private _selectedTask: Task | null = null;
  private _outputPath = '';
  private _dataOutputDir = '';
  private _dataOptions: TaskDataOption[] = TASK_DATA_CATEGORIES.map(item => ({ ...item, available: false }));
  private _dataCategories: TaskDataCategory[] = [];
  private _downloadedData: TaskDataDownload[] = [];
  private _sourceMode: 'notebook' | 'file' = 'notebook';
  private _sourcePath = '';
  private _useSubmissionProxy = false;
  private _note = '';
  private _busy = false;
  private _busyMessage: string | null = null;
  private _error: string | null = null;
  private _pickerResolver: ((value: string | null) => void) | null = null;
  private _pickerState: PickerState | null = null;
  private _result: SubmissionResult | null = null;
  private _submissionHistory: SubmissionResult[] = [];
  private _submissionCount: number | string | null = null;
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
