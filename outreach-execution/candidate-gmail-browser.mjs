import { selectApplicationChromeProfile } from '../application-execution/browser-profile.mjs';

const shellQuote=value=>`'${String(value).replaceAll("'",`'\\''`)}'`;

export function candidateGmailBrowserCommand(env=process.env){
  const selection=selectApplicationChromeProfile({
    profile:env.APPLICATION_BROWSER_PROFILE||'jorge',
    mode:env.APPLICATION_BROWSER_MODE||'application_submit',
    userDataDir:env.APPLICATION_BROWSER_USER_DATA_DIR||env.BROWSER_USER_DATA_DIR,
  });
  if(selection.profileName.toLowerCase()!=='jorge')throw new Error('candidate Gmail authorization requires Chrome profile Jorge');
  return `/usr/bin/open -n -a ${shellQuote('Google Chrome')} --args --profile-directory=${shellQuote(selection.profileDirectory)} --new-window %s`;
}
