#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const packagePath = path.join(root, 'package.json');
const lockPath = path.join(root, 'package-lock.json');
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function assertVersion(value, label) {
    if (typeof value !== 'string' || !semverPattern.test(value)) {
        throw new Error(`${label} is not a valid semantic version: ${value}`);
    }
}

function verify(packageJson, packageLock) {
    assertVersion(packageJson.version, 'package.json version');

    const lockVersions = [
        ['package-lock.json version', packageLock.version],
        ['package-lock.json root package version', packageLock.packages?.['']?.version],
    ];
    for (const [label, version] of lockVersions) {
        assertVersion(version, label);
        if (version !== packageJson.version) {
            throw new Error(
                `${label} (${version}) does not match package.json (${packageJson.version})`,
            );
        }
    }
}

function nextVersion(currentVersion, requested) {
    if (['major', 'minor', 'patch'].includes(requested)) {
        const match = semverPattern.exec(currentVersion);
        const parts = match.slice(1, 4).map(Number);

        if (requested === 'major') return `${parts[0] + 1}.0.0`;
        if (requested === 'minor') return `${parts[0]}.${parts[1] + 1}.0`;
        return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
    }

    assertVersion(requested, 'requested version');
    return requested;
}

function main() {
    const command = process.argv[2] || 'show';
    const packageJson = readJson(packagePath);
    const packageLock = readJson(lockPath);

    if (command === 'show') {
        console.log(packageJson.version);
        return;
    }

    if (command === 'check') {
        verify(packageJson, packageLock);
        console.log(`Version ${packageJson.version} is valid and synchronized.`);
        return;
    }

    if (command === 'bump') {
        verify(packageJson, packageLock);
        const requested = process.argv[3];
        if (!requested) {
            throw new Error('Usage: node scripts/version.js bump <major|minor|patch|x.y.z>');
        }

        const version = nextVersion(packageJson.version, requested);
        if (version === packageJson.version) {
            throw new Error(`Version is already ${version}.`);
        }

        packageJson.version = version;
        packageLock.version = version;
        packageLock.packages[''].version = version;
        writeJson(packagePath, packageJson);
        writeJson(lockPath, packageLock);
        console.log(`Version updated to ${version}.`);
        return;
    }

    throw new Error(`Unknown command: ${command}`);
}

try {
    main();
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
