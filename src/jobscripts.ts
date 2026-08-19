import * as vscode from 'vscode';
import * as path from 'path';
import { Scheduler } from './scheduler';
import { getBaseName, getPathRelativeToWorkspaceRoot } from './fileutilities';

/**
 * Represents a job script item in the tree view. Each item corresponds
 * to a job script file in the workspace.
 */
export class JobScript extends vscode.TreeItem {
    /**
     * Creates a new instance of the JobScript class.
     * @param fpath The file path or URI of the job script.
     * @param stat The file stat of the job script.
     */
    constructor(
        public fpath: string | vscode.Uri,
        public stat?: vscode.FileStat,
        isFavorite: boolean = false
    ) {
        super(getBaseName(fpath), vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('file-code');
        this.tooltip = fpath.toString();
        this.description = getPathRelativeToWorkspaceRoot(fpath);
        this.contextValue = isFavorite ? 'favoriteJobScript' : 'jobScript';
        this.command = {
            title: 'Show Source',
            command: 'submit-dashboard.show-source',
            arguments: [this],
        };
    }
}

export const JOB_SCRIPT_FAVORITES_KEY = 'submit-dashboard.favoriteJobScripts';

/** Archives submitted job scripts with their Slurm job ID. */
export class SubmittedJobScriptArchive {
    public async archive(source: vscode.Uri, jobId: string): Promise<vscode.Uri | undefined> {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(source) ?? vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showWarningMessage(
                'Job submitted, but its script could not be archived outside a workspace.'
            );
            return undefined;
        }

        const archiveDirectory = vscode.workspace
            .getConfiguration('slurm-dashboard', source)
            .get('submit-dashboard.archiveDirectory', 'slurm-job-history');
        if (!archiveDirectory) {
            return undefined;
        }

        const normalizedDirectory = archiveDirectory.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
        if (
            path.posix.isAbsolute(normalizedDirectory) ||
            /^[a-zA-Z]:\//.test(normalizedDirectory) ||
            normalizedDirectory.split('/').includes('..')
        ) {
            vscode.window.showErrorMessage(
                'Job submitted, but the configured archive directory must be a path inside the workspace.'
            );
            return undefined;
        }

        const archiveUri = vscode.Uri.joinPath(workspaceFolder.uri, normalizedDirectory);
        const parsedName = path.posix.parse(source.path);
        const safeJobId = jobId.replace(/[^a-zA-Z0-9_.-]/g, '_');
        const archivedName = `${parsedName.name}_${safeJobId}${parsedName.ext}`;
        const destination = vscode.Uri.joinPath(archiveUri, archivedName);

        try {
            await vscode.workspace.fs.createDirectory(archiveUri);
            await vscode.workspace.fs.copy(source, destination, { overwrite: false });
            return destination;
        } catch (error) {
            vscode.window.showErrorMessage(
                `Job ${jobId} was submitted, but its script could not be archived in ${archiveUri.fsPath}.\nError: ${error}`
            );
            return undefined;
        }
    }
}

/** Stores the user's favorite job scripts in the current workspace. */
export class JobScriptFavorites {
    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    constructor(private workspaceState: vscode.Memento) {}

    public getUris(): vscode.Uri[] {
        return this.workspaceState.get<string[]>(JOB_SCRIPT_FAVORITES_KEY, []).map(value => vscode.Uri.parse(value));
    }

    public isFavorite(uri: vscode.Uri): boolean {
        return this.getUris().some(favorite => favorite.toString() === uri.toString());
    }

    public async add(uri: vscode.Uri): Promise<void> {
        if (this.isFavorite(uri)) {
            return;
        }

        const favorites = this.getUris().map(favorite => favorite.toString());
        favorites.push(uri.toString());
        await this.workspaceState.update(JOB_SCRIPT_FAVORITES_KEY, favorites);
        this._onDidChange.fire();
    }

    public async remove(uri: vscode.Uri): Promise<void> {
        const favorites = this.getUris()
            .filter(favorite => favorite.toString() !== uri.toString())
            .map(favorite => favorite.toString());
        await this.workspaceState.update(JOB_SCRIPT_FAVORITES_KEY, favorites);
        this._onDidChange.fire();
    }
}

/**
 * Sorts an array of JobScript objects based on the specified key.
 *
 * @param scripts - The array of JobScript objects to be sorted.
 * @param key - The key to determine the sorting order. Valid keys are "filename", "rel path", "last modified", "newest", and "oldest".
 * @returns void
 */
export function sortJobsScripts(scripts: JobScript[], key: string | null | undefined): void {
    if (!key) {
        return;
    }

    const AVAILABLE_KEYS = ['filename', 'rel path', 'last modified', 'newest', 'oldest'];
    if (!AVAILABLE_KEYS.includes(key)) {
        vscode.window.showErrorMessage(`Invalid sort key: ${key}`);
        return;
    }

    scripts.sort((a, b) => {
        if (key === 'filename') {
            return getBaseName(a.fpath).localeCompare(getBaseName(b.fpath));
        } else if (key === 'rel path') {
            return getPathRelativeToWorkspaceRoot(a.fpath).localeCompare(getPathRelativeToWorkspaceRoot(b.fpath));
        } else if (key === 'last modified') {
            if (a.stat && b.stat) {
                return b.stat.mtime - a.stat.mtime;
                /* c8 ignore next 3 */
            } else {
                return 0;
            }
        } else if (key === 'newest' || key === 'oldest') {
            if (a.stat && b.stat) {
                return key === 'newest' ? b.stat.ctime - a.stat.ctime : a.stat.ctime - b.stat.ctime;
                /* c8 ignore next 3 */
            } else {
                return 0;
            }
            /* c8 ignore next 3 */
        } else {
            return 0;
        }
    });
}

/**
 * Represents a provider for job scripts in the tree view.
 */
export class JobScriptProvider implements vscode.TreeDataProvider<JobScript> {
    private jobScripts: JobScript[] = [];

    private _onDidChangeTreeData: vscode.EventEmitter<JobScript | undefined | null | void> = new vscode.EventEmitter<
        JobScript | undefined | null | void
    >();
    readonly onDidChangeTreeData: vscode.Event<JobScript | undefined | null | void> = this._onDidChangeTreeData.event;

    /**
     * Creates a new instance of JobScriptProvider. Scheduler object is used
     * for submitting jobs.
     * @param scheduler The scheduler used for submitting jobs.
     */
    constructor(
        private scheduler: Scheduler,
        private favorites?: JobScriptFavorites
    ) {}

    /**
     * Gets the tree item for the specified element.
     * @param element The job script element.
     * @returns The tree item representing the job script.
     */
    getTreeItem(element: JobScript): vscode.TreeItem | Thenable<vscode.TreeItem> {
        return element;
    }

    /**
     * Gets the children of the specified element. Yields all job scripts in the workspace.
     * @param element The job script element.
     * @returns The children of the job script element.
     */
    getChildren(element?: JobScript): vscode.ProviderResult<JobScript[]> {
        if (element) {
            return Promise.resolve([]);
        } else {
            return Promise.resolve(this.getAllJobScripts());
        }
    }

    private getJobScriptFilePatterns(): string[] {
        /* first check if slurm-dashboard.submit-dashboard.jobScriptExtensions
           is not set to the default. If so, show a warning message, since
           this is deprecated.
        */
        const jobScriptExts = vscode.workspace
            .getConfiguration('slurm-dashboard')
            .get('submit-dashboard.jobScriptExtensions', ['.slurm', '.sbatch', '.job']);
        /* c8 ignore next 7 */
        if (JSON.stringify(jobScriptExts) !== JSON.stringify(['.slurm', '.sbatch', '.job'])) {
            vscode.window.showWarningMessage(
                'The slurm-dashboard.submit-dashboard.jobScriptExtensions setting has been modified, but ' +
                    'is deprecated. It will be removed in a future version. Please use the ' +
                    'slurm-dashboard.submit-dashboard.jobScriptPatterns setting instead.'
            );
        }

        /* grab the glob patterns from the jobScriptPatterns setting */
        const jobScriptPatterns = vscode.workspace
            .getConfiguration('slurm-dashboard')
            .get('submit-dashboard.jobScriptPatterns', ['**/*.slurm', '**/*.sbatch', '**/*.job']);
        return jobScriptPatterns;
    }

    private getArchiveExcludePattern(): string | undefined {
        const archiveDirectory = vscode.workspace
            .getConfiguration('slurm-dashboard')
            .get('submit-dashboard.archiveDirectory', 'slurm-job-history');
        if (!archiveDirectory) {
            return undefined;
        }
        const normalizedDirectory = archiveDirectory.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
        return `**/${normalizedDirectory}/**`;
    }

    /**
     * Retrieves all job scripts in the workspace.
     * Searches for job scripts based on the extensions specified by
     * the slurm-dashboard.submit-dashboard.jobScriptExtensions setting.
     * Sorts the job scripts based on the slurm-dashboard.submit-dashboard.sortBy setting.
     * @returns A promise that resolves to an array of job scripts.
     */
    private getAllJobScripts(): Promise<JobScript[]> {
        const patterns = this.getJobScriptFilePatterns();
        const archiveExcludePattern = this.getArchiveExcludePattern();

        /* find all files in workspace with job script extensions */
        let foundFiles: PromiseLike<JobScript[]>[] = [];
        patterns.forEach(pattern => {
            let jobScripts = vscode.workspace.findFiles(pattern, archiveExcludePattern).then(uris => {
                let stats = uris.map(uri => vscode.workspace.fs.stat(uri));
                return Promise.all(stats).then(stats => {
                    return uris.map((uri, i) => new JobScript(uri, stats[i], this.favorites?.isFavorite(uri)));
                });
            });
            foundFiles.push(jobScripts);
        });
        return Promise.all(foundFiles).then(jobScripts => {
            const sortKey: string | null | undefined = vscode.workspace
                .getConfiguration('slurm-dashboard')
                .get('submit-dashboard.sortBy');
            const scripts = jobScripts.flat();
            sortJobsScripts(scripts, sortKey);
            this.jobScripts = scripts;
            return scripts;
        });
    }

    /**
     * Registers the JobScriptProvider with the extension context.
     * @param context The extension context.
     */
    public register(context: vscode.ExtensionContext): void {
        this.favorites ??= new JobScriptFavorites(context.workspaceState);

        let submitView = vscode.window.registerTreeDataProvider('submit-dashboard', this);
        context.subscriptions.push(submitView);
        context.subscriptions.push(this.favorites.onDidChange(() => this.refresh()));

        context.subscriptions.push(
            vscode.commands.registerCommand('submit-dashboard.refresh', () => this.refresh()),
            vscode.commands.registerCommand('submit-dashboard.submit-all', () => this.submitAll()),
            vscode.commands.registerCommand('submit-dashboard.submit', (jobScript: JobScript) =>
                this.submit(jobScript)
            ),
            vscode.commands.registerCommand('submit-dashboard.show-source', (jobScript: JobScript) =>
                this.showSource(jobScript)
            ),
            vscode.commands.registerCommand('submit-dashboard.add-favorite', (jobScript: JobScript) =>
                this.addFavorite(jobScript)
            ),
            vscode.commands.registerCommand('submit-dashboard.remove-favorite', (jobScript: JobScript) =>
                this.removeFavorite(jobScript)
            )
        );
    }

    /**
     * Refreshes the tree view by clearing the job scripts. Refreshes
     * the entire tree view.
     */
    public refresh(): void {
        this.jobScripts = [];
        this._onDidChangeTreeData.fire();
    }

    /**
     * Submits all job scripts.
     * if slurm-dashboard.submit-dashboard.promptBeforeSubmitAll is true, then
     * prompts the user before submitting all job scripts.
     * @returns A promise that resolves to true if all job scripts were submitted, false otherwise.
     */
    private async submitAll(): Promise<boolean> {
        const shouldPrompt: boolean = vscode.workspace
            .getConfiguration('slurm-dashboard')
            .get('submit-dashboard.promptBeforeSubmitAll', true);

        if (shouldPrompt) {
            /* c8 ignore start */
            const numJobs = this.jobScripts.length;
            const value = await vscode.window.showInformationMessage(
                `Are you sure you want to submit all ${numJobs} jobs?`,
                'Yes',
                'No'
            );
            if (value === 'Yes') {
                await Promise.all(this.jobScripts.map(jobScript => this.submit(jobScript)));
            }
            return value === 'Yes';
            /* c8 ignore stop */
        } else {
            await Promise.all(this.jobScripts.map(jobScript => this.submit(jobScript)));
            return true;
        }
    }

    /**
     * Submits a job script. Uses the scheduler object to submit the job.
     * @param jobScript The job script to submit.
     */
    private async submit(jobScript: JobScript): Promise<void> {
        const jobId = this.scheduler.submitJob(jobScript.fpath);
        if (jobId) {
            const archive = new SubmittedJobScriptArchive();
            await archive.archive(this.getUri(jobScript), jobId);
        }
    }

    private addFavorite(jobScript: JobScript): Promise<void> {
        return this.favorites!.add(this.getUri(jobScript));
    }

    private removeFavorite(jobScript: JobScript): Promise<void> {
        return this.favorites!.remove(this.getUri(jobScript));
    }

    private getUri(jobScript: JobScript): vscode.Uri {
        return jobScript.fpath instanceof vscode.Uri ? jobScript.fpath : vscode.Uri.file(jobScript.fpath);
    }

    /**
     * Shows the source code of a job script in a new editor tab.
     * @param jobScript The job script to show the source code for.
     */
    private showSource(jobScript: JobScript): void {
        const fpath = jobScript.fpath as vscode.Uri;
        vscode.workspace.openTextDocument(fpath).then(doc => {
            vscode.window.showTextDocument(doc);
        });
    }
}

/** Provides the favorite job scripts tree view. */
export class FavoriteJobScriptProvider implements vscode.TreeDataProvider<JobScript> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private favorites: JobScriptFavorites) {}

    public getTreeItem(element: JobScript): vscode.TreeItem {
        return element;
    }

    public async getChildren(element?: JobScript): Promise<JobScript[]> {
        if (element) {
            return [];
        }

        const scripts = await Promise.all(
            this.favorites.getUris().map(async uri => {
                try {
                    const stat = await vscode.workspace.fs.stat(uri);
                    return new JobScript(uri, stat, true);
                } catch {
                    return undefined;
                }
            })
        );
        const existingScripts = scripts.filter((script): script is JobScript => script !== undefined);
        const sortKey = vscode.workspace
            .getConfiguration('slurm-dashboard')
            .get<string | null>('submit-dashboard.sortBy');
        sortJobsScripts(existingScripts, sortKey);
        return existingScripts;
    }

    public register(context: vscode.ExtensionContext): void {
        context.subscriptions.push(
            vscode.window.registerTreeDataProvider('favorite-job-scripts-dashboard', this),
            this.favorites.onDidChange(() => this.refresh()),
            vscode.commands.registerCommand('favorite-job-scripts-dashboard.refresh', () => this.refresh())
        );
    }

    public refresh(): void {
        this._onDidChangeTreeData.fire();
    }
}
