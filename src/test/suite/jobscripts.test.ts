import * as assert from 'assert';
import * as fs from 'fs';
import { execSync } from 'child_process';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import * as jobscripts from '../../jobscripts';
import { WallTime } from '../../time';
import { Job, Debug, SlurmScheduler } from '../../scheduler';
import { getBaseName, getPathRelativeToWorkspaceRoot } from '../../fileutilities';

suite('jobscripts.ts tests', () => {
    test('JobScript :: constructor', () => {
        {
            const fpath = vscode.Uri.file('job1.sbatch');
            const jobScript = new jobscripts.JobScript(fpath);
            assert.strictEqual(jobScript.label, 'job1.sbatch');
            assert.strictEqual(jobScript.collapsibleState, vscode.TreeItemCollapsibleState.None);
            assert.strictEqual(jobScript.tooltip, fpath.toString());
            assert.strictEqual(jobScript.description?.toString().slice(1), 'job1.sbatch');
            assert.strictEqual(jobScript.contextValue, 'jobScript');

            const favoriteJobScript = new jobscripts.JobScript(fpath, undefined, true);
            assert.strictEqual(favoriteJobScript.contextValue, 'favoriteJobScript');
        }
    });

    test('JobScriptProvider :: constructor', () => {
        const scheduler = new Debug();
        assert.doesNotThrow(() => {
            new jobscripts.JobScriptProvider(scheduler);
        });
    });

    test('JobScriptProvider :: getTreeItem', () => {
        const scheduler = new Debug();
        const provider = new jobscripts.JobScriptProvider(scheduler);
        const fpath = vscode.Uri.file('job1.sbatch');
        const jobScript = new jobscripts.JobScript(fpath);
        assert.strictEqual(provider.getTreeItem(jobScript), jobScript);
    });

    test('JobScriptProvider :: getChildren', async () => {
        const scheduler = new Debug();
        const provider = new jobscripts.JobScriptProvider(scheduler);

        let scripts = await provider.getChildren();

        assert.ok(scripts);
        assert.strictEqual(scripts.length, 3);
        assert.ok(scripts[0] instanceof jobscripts.JobScript);
        assert.strictEqual(scripts.filter(script => script.label === 'job1.sbatch').length, 1);

        let emptyChildren = await provider.getChildren(scripts[0]);
        assert.ok(emptyChildren);
        assert.strictEqual(emptyChildren.length, 0);
    });

    test('SubmittedJobScriptArchive :: archive and exclude from scripts', async () => {
        const configuration = vscode.workspace.getConfiguration('slurm-dashboard');
        const archiveSetting = 'submit-dashboard.archiveDirectory';
        const originalArchiveDirectory = configuration.get<string | null>(archiveSetting);
        const archiveDirectory = 'test-slurm-job-history';
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        assert.ok(workspaceRoot, 'workspace root not found');
        const archiveUri = vscode.Uri.joinPath(workspaceRoot, archiveDirectory);
        const source = vscode.Uri.joinPath(workspaceRoot, 'job1.sbatch');

        try {
            await configuration.update(archiveSetting, archiveDirectory);
            const archive = new jobscripts.SubmittedJobScriptArchive();
            const destination = await archive.archive(source, '12345_7');

            assert.ok(destination, 'job script was not archived');
            assert.strictEqual(destination.path.endsWith('/test-slurm-job-history/job1_12345_7.sbatch'), true);
            assert.strictEqual(
                Buffer.from(await vscode.workspace.fs.readFile(destination)).toString(),
                Buffer.from(await vscode.workspace.fs.readFile(source)).toString()
            );

            const provider = new jobscripts.JobScriptProvider(new Debug());
            const scripts = await provider.getChildren();
            assert.ok(scripts, 'no scripts found');
            assert.strictEqual(
                scripts.some(script => script.fpath.toString() === destination.toString()),
                false
            );
        } finally {
            await vscode.workspace.fs.delete(archiveUri, { recursive: true, useTrash: false });
            await configuration.update(archiveSetting, originalArchiveDirectory);
        }
    });

    test('JobScriptProvider :: register', async () => {
        const extension = vscode.extensions.getExtension('danielnichols.slurm-dashboard');
        assert.ok(extension, 'Extension not found');

        const scheduler = new Debug();
        const provider = new jobscripts.JobScriptProvider(scheduler);

        let context: vscode.ExtensionContext | undefined = undefined;
        context = await extension.activate();
        assert.ok(context, 'Extension context not found');

        assert.throws(() => {
            /* should already be initialized */
            provider.register(context!);
        });

        /* assert that submit-dashboard commands are registered */
        vscode.commands.getCommands(false).then(commands => {
            assert.ok(commands.includes('submit-dashboard.refresh'));
            assert.ok(commands.includes('submit-dashboard.submit-all'));
            assert.ok(commands.includes('submit-dashboard.submit'));
            assert.ok(commands.includes('submit-dashboard.show-source'));
            assert.ok(commands.includes('submit-dashboard.add-favorite'));
            assert.ok(commands.includes('submit-dashboard.remove-favorite'));
            assert.ok(commands.includes('favorite-job-scripts-dashboard.refresh'));
        });
    });

    test('JobScriptFavorites and FavoriteJobScriptProvider', async () => {
        const extension = vscode.extensions.getExtension('danielnichols.slurm-dashboard');
        assert.ok(extension, 'Extension not found');
        const context = (await extension.activate()) as vscode.ExtensionContext;
        const originalFavorites = context.workspaceState.get<string[]>(jobscripts.JOB_SCRIPT_FAVORITES_KEY);
        const scheduler = new Debug();
        const jobScriptProvider = new jobscripts.JobScriptProvider(scheduler);
        const scripts = await jobScriptProvider.getChildren();
        assert.ok(scripts, 'no scripts found');
        const uri = scripts[0].fpath as vscode.Uri;

        try {
            await context.workspaceState.update(jobscripts.JOB_SCRIPT_FAVORITES_KEY, []);
            const favorites = new jobscripts.JobScriptFavorites(context.workspaceState);
            const favoriteProvider = new jobscripts.FavoriteJobScriptProvider(favorites);

            await favorites.add(uri);
            await favorites.add(uri);
            assert.ok(favorites.isFavorite(uri));
            assert.strictEqual(favorites.getUris().length, 1);

            const favoriteScripts = await favoriteProvider.getChildren();
            assert.strictEqual(favoriteScripts.length, 1);
            assert.strictEqual(favoriteScripts[0].fpath.toString(), uri.toString());
            assert.strictEqual(favoriteScripts[0].contextValue, 'favoriteJobScript');
            assert.deepStrictEqual(await favoriteProvider.getChildren(favoriteScripts[0]), []);

            await favorites.remove(uri);
            assert.ok(!favorites.isFavorite(uri));
            assert.strictEqual((await favoriteProvider.getChildren()).length, 0);
        } finally {
            await context.workspaceState.update(jobscripts.JOB_SCRIPT_FAVORITES_KEY, originalFavorites);
        }
    });

    test('sortJobScripts', async () => {
        const scheduler = new Debug();
        const provider = new jobscripts.JobScriptProvider(scheduler);

        {
            /* null key */
            const scripts = await provider.getChildren();
            assert.ok(scripts);
            let newScripts = Array.from(scripts);
            assert.strictEqual(newScripts.length, 3, 'sortJobScripts  key=null  invalid scripts length');

            jobscripts.sortJobsScripts(newScripts, null);
            newScripts.forEach((script, idx) => {
                assert.strictEqual(
                    script.label,
                    scripts[idx].label,
                    `sortJobScripts  key=null  invalid element ${idx}`
                );
            });
        }

        {
            /* unknown key */
            const scripts = await provider.getChildren();
            assert.ok(scripts);
            let newScripts = Array.from(scripts);
            assert.strictEqual(newScripts.length, 3, 'sortJobScripts  key=unknown  invalid scripts length');

            jobscripts.sortJobsScripts(newScripts, 'unknown key -- gibberish');
            newScripts.forEach((script, idx) => {
                assert.strictEqual(
                    script.label,
                    scripts[idx].label,
                    `sortJobScripts  key=null  invalid element ${idx}`
                );
            });
        }

        {
            /* filename key */
            let scripts = await provider.getChildren();
            assert.ok(scripts);
            scripts = Array.from(scripts);
            assert.strictEqual(scripts.length, 3, 'sortJobScripts  key=filename  invalid scripts length');
            jobscripts.sortJobsScripts(scripts, 'filename');

            assert.ok(getBaseName(scripts[0].fpath) <= getBaseName(scripts[1].fpath), 'sortJobScripts  key=filename');
            assert.ok(getBaseName(scripts[1].fpath) <= getBaseName(scripts[2].fpath), 'sortJobScripts  key=filename');
        }

        {
            /* rel path key */
            let scripts = await provider.getChildren();
            assert.ok(scripts);
            scripts = Array.from(scripts);
            assert.strictEqual(scripts.length, 3, 'sortJobScripts  key=rel path  invalid scripts length');
            jobscripts.sortJobsScripts(scripts, 'rel path');

            assert.ok(
                getPathRelativeToWorkspaceRoot(scripts[0].fpath) <= getPathRelativeToWorkspaceRoot(scripts[1].fpath),
                'sortJobScripts  key=rel path'
            );
            assert.ok(
                getPathRelativeToWorkspaceRoot(scripts[1].fpath) <= getPathRelativeToWorkspaceRoot(scripts[2].fpath),
                'sortJobScripts  key=rel path'
            );
        }

        {
            /* last modified key */
            let scripts = await provider.getChildren();
            assert.ok(scripts);
            scripts = Array.from(scripts);
            assert.strictEqual(scripts.length, 3, 'sortJobScripts  key=last modified  invalid scripts length');
            jobscripts.sortJobsScripts(scripts, 'last modified');
            scripts.forEach(script => {
                assert.ok(script.stat, 'sortJobScripts  key=last modified  invalid stat');
            });

            assert.ok(
                scripts[0].stat!.mtime >= scripts[1].stat!.mtime,
                `sortJobScripts  key=last modified  ${scripts[0].stat!.mtime} < ${scripts[1].stat!.mtime}`
            );
            assert.ok(
                scripts[1].stat!.mtime >= scripts[2].stat!.mtime,
                `sortJobScripts  key=last modified  ${scripts[1].stat!.mtime} < ${scripts[2].stat!.mtime}`
            );
        }

        {
            /* newest key */
            let scripts = await provider.getChildren();
            assert.ok(scripts);
            scripts = Array.from(scripts);
            assert.strictEqual(scripts.length, 3, 'sortJobScripts  key=newest  invalid scripts length');
            jobscripts.sortJobsScripts(scripts, 'newest');
            scripts.forEach(script => {
                assert.ok(script.stat, 'sortJobScripts  key=newest  invalid stat');
            });

            assert.ok(
                scripts[0].stat!.ctime >= scripts[1].stat!.ctime,
                `sortJobScripts  key=newest  ${scripts[0].stat!.ctime} < ${scripts[1].stat!.ctime}`
            );
            assert.ok(
                scripts[1].stat!.ctime >= scripts[2].stat!.ctime,
                `sortJobScripts  key=newest  ${scripts[1].stat!.ctime} < ${scripts[2].stat!.ctime}`
            );
        }

        {
            /* oldest key */
            let scripts = await provider.getChildren();
            assert.ok(scripts);
            scripts = Array.from(scripts);
            assert.strictEqual(scripts.length, 3, 'sortJobScripts  key=oldest  invalid scripts length');
            jobscripts.sortJobsScripts(scripts, 'oldest');
            scripts.forEach(script => {
                assert.ok(script.stat, 'sortJobScripts  key=oldest  invalid stat');
            });

            assert.ok(
                scripts[0].stat!.ctime <= scripts[1].stat!.ctime,
                `sortJobScripts  key=newest  ${scripts[0].stat!.ctime} < ${scripts[1].stat!.ctime}`
            );
            assert.ok(
                scripts[1].stat!.ctime <= scripts[2].stat!.ctime,
                `sortJobScripts  key=newest  ${scripts[1].stat!.ctime} < ${scripts[2].stat!.ctime}`
            );
        }
    });

    test('JobScriptProvider :: refresh', async () => {
        const scheduler = new Debug();
        const provider = new jobscripts.JobScriptProvider(scheduler);

        let scripts = await provider.getChildren();
        assert.ok(scripts);
        assert.strictEqual(scripts.length, 3);

        await assert.doesNotThrow(async () => {
            await provider.refresh();
        });
        scripts = await provider.getChildren();
        assert.ok(scripts);
        assert.strictEqual(scripts.length, 3);
    });

    test('commands :: submit-dashboard.refresh', async () => {
        const scheduler = new Debug();
        const provider = new jobscripts.JobScriptProvider(scheduler);
        const oldScripts = await provider.getChildren();
        assert.ok(oldScripts, 'no scripts found');
        assert.strictEqual(oldScripts.length, 3, 'invalid scripts length');

        /* write a new job file to the workspace */
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? '';
        const fpath = vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), 'new-job.sbatch');
        const jobFile = `#!/bin/bash\necho "Hello, world!"\n`;
        fs.writeFileSync(fpath.fsPath, jobFile);

        await assert.doesNotThrow(async () => {
            await vscode.commands.executeCommand('submit-dashboard.refresh');
        });

        const newScripts = await provider.getChildren();
        assert.ok(newScripts, 'no scripts found');
        assert.strictEqual(newScripts.length, 4, 'invalid scripts length');

        /* delete scratch file */
        fs.unlinkSync(fpath.fsPath);
    });

    test('commands :: submit-dashboard.submit-all', async function () {
        {
            assert.doesNotThrow(async () => {
                await vscode.workspace
                    .getConfiguration('slurm-dashboard')
                    .update('submit-dashboard.promptBeforeSubmitAll', true);
                vscode.commands.executeCommand('submit-dashboard.submit-all');
            });
        }

        assert.doesNotThrow(async () => {
            await vscode.workspace
                .getConfiguration('slurm-dashboard')
                .update('submit-dashboard.promptBeforeSubmitAll', false);
            vscode.commands.executeCommand('submit-dashboard.submit-all');
        });
    });

    test('commands :: submit', async function () {
        const scheduler = new Debug();
        const provider = new jobscripts.JobScriptProvider(scheduler);
        const scripts = await provider.getChildren();
        assert.ok(scripts, 'no scripts found');
        assert.strictEqual(scripts.length, 3, 'invalid scripts length');
        const configuration = vscode.workspace.getConfiguration('slurm-dashboard');
        const archiveSetting = 'submit-dashboard.archiveDirectory';
        const originalArchiveDirectory = configuration.get<string | null>(archiveSetting);
        const archiveDirectory = 'test-submit-archive';
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        assert.ok(workspaceRoot, 'workspace root not found');
        const archiveUri = vscode.Uri.joinPath(workspaceRoot, archiveDirectory);

        try {
            await configuration.update(archiveSetting, archiveDirectory);
            await vscode.commands.executeCommand('submit-dashboard.submit', scripts[0]);
            const archivedFiles = await vscode.workspace.fs.readDirectory(archiveUri);
            const sourceName = getBaseName(scripts[0].fpath);
            const extensionIndex = sourceName.lastIndexOf('.');
            const sourceStem = sourceName.slice(0, extensionIndex);
            const sourceExtension = sourceName.slice(extensionIndex);
            assert.strictEqual(
                archivedFiles.some(([name]) => {
                    const prefix = `${sourceStem}_`;
                    const jobId = name.slice(prefix.length, -sourceExtension.length);
                    return name.startsWith(prefix) && name.endsWith(sourceExtension) && /^\d+$/.test(jobId);
                }),
                true
            );
        } finally {
            await vscode.workspace.fs.delete(archiveUri, { recursive: true, useTrash: false });
            await configuration.update(archiveSetting, originalArchiveDirectory);
        }
    });

    test('commands :: show-source', async function () {
        const scheduler = new Debug();
        const provider = new jobscripts.JobScriptProvider(scheduler);
        const scripts = await provider.getChildren();
        assert.ok(scripts, 'no scripts found');
        assert.strictEqual(scripts.length, 3, 'invalid scripts length');

        assert.doesNotThrow(async () => {
            await vscode.commands.executeCommand('submit-dashboard.show-source', scripts[0]);
        });
    });

    test('commands :: add and remove favorite', async () => {
        const extension = vscode.extensions.getExtension('danielnichols.slurm-dashboard');
        assert.ok(extension, 'Extension not found');
        const context = (await extension.activate()) as vscode.ExtensionContext;
        const originalFavorites = context.workspaceState.get<string[]>(jobscripts.JOB_SCRIPT_FAVORITES_KEY);
        const provider = new jobscripts.JobScriptProvider(new Debug());
        const scripts = await provider.getChildren();
        assert.ok(scripts, 'no scripts found');
        const uri = scripts[0].fpath as vscode.Uri;

        try {
            await context.workspaceState.update(jobscripts.JOB_SCRIPT_FAVORITES_KEY, []);
            await vscode.commands.executeCommand('submit-dashboard.add-favorite', scripts[0]);
            assert.deepStrictEqual(context.workspaceState.get(jobscripts.JOB_SCRIPT_FAVORITES_KEY), [uri.toString()]);

            await vscode.commands.executeCommand('submit-dashboard.remove-favorite', scripts[0]);
            assert.deepStrictEqual(context.workspaceState.get(jobscripts.JOB_SCRIPT_FAVORITES_KEY), []);
        } finally {
            await context.workspaceState.update(jobscripts.JOB_SCRIPT_FAVORITES_KEY, originalFavorites);
        }
    });
});
