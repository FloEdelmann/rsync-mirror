#!/usr/bin/env node
const child_process = require(`child_process`);
const fs = require(`fs`);
const nodemailer = require(`nodemailer`);
const path = require(`path`);

if (process.argv.length !== 3) {
  console.error(`Usage: ${__filename} <config filename>`)
  process.exit(1);
}

const configPath = path.resolve(process.argv[2]);
const configDirectory = path.dirname(configPath);
let config;

try {
  console.log(`Using config file:`, configPath);
  config = require(configPath);
}
catch (error) {
  console.error(`Could not read config file:`, error.message);
  process.exit(1);
}

const DEBUG_MOCK_RSYNC = false;
const DEBUG_RSYNC_OUTPUT = `*deleting   www/wp/wordpress/test/e
.d..t...... www/wp/wordpress/test/
>f+++++++++ www/wp/wordpress/test/a
>f.st...... www/wp/wordpress/test/d
cd+++++++++ www/wp/wordpress/test/newdir/
>f+++++++++ www/wp/wordpress/test/newdir/xxx
>f+++++++++ www/wp/wordpress/wp-content/backupwordpress-d200fbdae6-backups/297344-webhosting75-1blu-de-1441741582-database-2019-12-27-10-58-54.zip
`;
const DEBUG_MOCK_ZIP = false; // beware, this will potentially delete older passed backups!
const DEBUG_SKIP_EMAIL = false;

console.log();
console.log(`==================`);
console.log(`rsync-mirror at ${(new Date()).toISOString()}`);
console.log(`==================`);
console.log();

(async () => {
  try {
    const mirrorDirectory = path.join(configDirectory, config.mirrorDirectory);
    fs.mkdirSync(mirrorDirectory, { recursive: true });

    const rsyncCommand = `rsync --recursive --exclude="${config.server.excludePattern || ``}" --times --itemize-changes --delete --copy-links ${config.server.username}@${config.server.url}:${config.server.rootDirectory} ${mirrorDirectory}`;
    console.log(`Executing rsync with command: ${rsyncCommand}\n`);

    // throws if the rsync command fails,
    // i.e. if it times out (default timeout: undefined) or has a non-zero exitcode
    const rsyncOutput = DEBUG_MOCK_RSYNC ? DEBUG_RSYNC_OUTPUT : child_process.execSync(rsyncCommand, { encoding: `utf8` });

    console.log(`rsync finished without errors. stdout:`);
    console.log(`--------`);
    console.log(rsyncOutput);
    console.log(`--------\n`);

    const deletedFiles = [];
    const addedFiles = [];
    const modifiedFiles = [];

    // see https://linux.die.net/man/1/rsync to understand the output
    const deletedRegex = /^\*deleting   (?<file>.*)$/; // see --delete option
    const itemizedRegex = /^(?<updateType>[>c.])(?<fileType>[fd])(?<attributes>[+.cstTpoguax]{9}) (?<file>.*)$/; // see --itemize-changes option

    console.log(`Parsing rsync output...`)
    const outputLines = rsyncOutput.split(`\n`).slice(0, -1);
    for (const line of outputLines) {
      const deletedRegexResult = deletedRegex.exec(line);
      const itemizedRegexResult = itemizedRegex.exec(line);

      if (deletedRegexResult !== null) {
        deletedFiles.push(deletedRegexResult.groups.file);
      }
      else if (itemizedRegexResult != null) {
        // only handle downloaded files
        if (itemizedRegexResult.groups.updateType === `>` && itemizedRegexResult.groups.fileType === `f`) {
          if (itemizedRegexResult.groups.attributes === `+++++++++`) {
            addedFiles.push(itemizedRegexResult.groups.file);
          }
          else {
            modifiedFiles.push(itemizedRegexResult.groups.file);
          }
        }
      }
      else {
        throw new Error(`Unable to handle rsync output:\n${line}`);
      }
    }
    console.log(`Done.\n`);

    const mailBodyLines = [
      `Deleted files (${deletedFiles.length}):`,
      ...deletedFiles.map(file => `- ${file}`),
      ``,
      `Added files (${addedFiles.length}):`,
      ...addedFiles.map(file => `- ${file}`),
      ``,
      `Modified files (${modifiedFiles.length}):`,
      ...modifiedFiles.map(file => `- ${file}`),
      ``
    ];
    console.log(mailBodyLines.join(`\n`));

    const requiredFileRegex = new RegExp(config.requiredFileRegex);
    const requiredFiles = addedFiles.filter(
      file => requiredFileRegex.exec(file) !== null
    );

    const passed = requiredFiles.length > 0;
    if (passed) {
      mailBodyLines.unshift(
        `Mirroring the ${config.server.url} server data was successful.`,
        `These are the required files that were downloaded today:`,
        ...requiredFiles.map(file => `- ${file}`),
        ``
      );
    }
    else {
      mailBodyLines.unshift(
        `Mirroring the ${config.server.url} server data has failed, as there was no file added that matches the following regex:`,
        requiredFileRegex,
        ``
      );
    }

    const archiveDirectory = path.join(configDirectory, config.archive.directory);

    const sanitizedDate = (new Date()).toISOString() // e.g. 2019-12-27T22:58:02.786Z
      .replace(/\.\d\d\dZ$/, ``) // => 2019-12-27T22:58:02
      .replace(/T/, `_`) // => 2019-12-27_22:58:02
      .replace(/:/g, `-`); // => 2019-12-27_22-58-02
    const newArchiveFile = path.join(archiveDirectory, `backup_${config.server.url}_${sanitizedDate}_${passed ? `passed` : `failed`}.zip`);
    const zipCommand = `zip --quiet -r ${newArchiveFile} ${DEBUG_MOCK_ZIP ? `./www/wp/wordpress/wp-admin/` : `.`}`;

    console.log(`Archiving current mirror directory (cwd: mirror directory): ${zipCommand} ...`);
    fs.mkdirSync(archiveDirectory, { recursive: true });
    const zipOutput = child_process.execSync(zipCommand, { cwd: mirrorDirectory, encoding: `utf8` });
    if (zipOutput !== ``) {
      throw new Error(`Unexpected stdout from zip command:\n${zipOutput}`);
    }
    console.log(`Zipping done.\n`);

    console.log(`Cleaning up archive...`);
    const zips = fs.readdirSync(archiveDirectory).sort().reverse(); // newest first; we rely on the date in the file name
    const passedZips = zips.filter(zip => zip.match(/passed\.zip$/));
    const deletedPassedZips = passedZips.splice(config.archive.keepPassed);
    const failedZips = zips.filter(zip => zip.match(/failed\.zip$/));
    const deletedFailedZips = failedZips.splice(config.archive.keepFailed);
    const deletedZips = deletedPassedZips.concat(deletedFailedZips).sort();
    deletedZips.forEach(zip => {
      const zipPath = path.join(archiveDirectory, zip);
      console.log(`Deleting ${zipPath}`);
      fs.unlinkSync(zipPath);
    })
    console.log(`Done.\n`);

    mailBodyLines.push(
      `Latest zips in ${archiveDirectory}:`,
      ...passedZips.concat(failedZips).sort().map(zip => `- ${zip}`),
      ``
    );

    if (deletedZips.length > 0) {
      mailBodyLines.push(
        `Deleted old zips in ${archiveDirectory}:`,
        ...deletedPassedZips.concat(deletedFailedZips).sort().map(zip => `- ${zip}`),
        ``
      );
    }

    mailBodyLines.push(`This email was sent by ${__filename}`);

    await sendMail(passed ? `PASS` : `FAIL`, mailBodyLines.join(`\n`));

    console.log(`Done at ${(new Date()).toISOString()}.`);
  }
  catch (error) {
    try {
      await sendMail(`FAIL`, `Script ${__filename} failed with following error:\n${error.stack}`);
    }
    catch (sendMailError) {
      console.error(`Error executing script:`);
      console.error(error);
    }
    finally {
      process.exit(1);
    }
  }
})();

/**
 * Sends a status email with sender and recipient defined in configuration.
 * @param {'FAIL'|'PASS'} failOrPass The labeled used as prefix in the mail subject.
 * @param {string} textContent The mail's body.
 */
async function sendMail(failOrPass = null, textContent = null) {
  const subject = `[${failOrPass}] ${config.server.url} mirror`;

  if (!failOrPass || !textContent) {
    throw new Error(`failOrPass and textContent must not be empty. ${JSON.stringify({failOrPass, textContent})}`);
  }

  console.log(`Send mail with subject '${subject}' and body:`);
  console.log(`--------`);
  console.log(textContent);
  console.log(`--------`);

  if (DEBUG_SKIP_EMAIL) {
    // we don't want to be annoyed by emails during development
    return;
  }

  const transporter = nodemailer.createTransport({
    host: config.email.mailer.host,
    port: config.email.mailer.port,
    secure: config.email.mailer.secure,
    auth: {
      user: config.email.mailer.username,
      pass: config.email.mailer.password
    }
  });

  const info = await transporter.sendMail({
    from: `"${config.server.url} mirror" <${config.email.mailer.username}>`,
    to: config.email.recipients.join(`, `),
    subject: subject,
    text: textContent,
    html: null
  });

  console.log(`Message sent:`, info);
}
