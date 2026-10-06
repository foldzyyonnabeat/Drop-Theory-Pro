Drop Theory Pro - Windows x64 offline bundle

This ZIP contains the regular runtime-only app installer and all pinned model
files for HTDemucs FT, HTDemucs FT Compact, HTDemucs, and UVR MDX-Net Inst HQ 5.
The UVR model produces vocals and instrumental stems. Its four-stem intro/outro
tool is unavailable because the model does not produce separate drums, bass,
and other stems. Model files are verified by SHA-256. No internet connection is
needed on the Windows PC during installation or first use.

Installation
1. Extract the complete ZIP to a writable folder and keep that folder available
   until setup finishes.
2. Close Drop Theory Pro if it is open.
3. Open PowerShell in the extracted folder and run:

   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-Offline.ps1

4. Follow the included app installer. The script then verifies and copies the
   model files into the app installation folder.
5. Wait for the final "Offline setup is complete" message before deleting the
   extracted bundle.

Allow about 5 GB of temporary free disk space while the extracted bundle and
installed model files coexist. The standard installer remains runtime-only;
this separate package supplies the models for offline use. Audio is processed
locally and is never uploaded.