use std::{
    env, fs,
    io,
    process::{self, Command},
};

const POWERSHELL_ARGS: [&str; 4] = [
    "-NoLogo",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
];

fn run() -> Result<i32, String> {
    let executable = env::current_exe()
        .map_err(|error| format!("Could not locate this setup file: {error}"))?;
    let bootstrap_directory = env::temp_dir().join(format!(
        "DropTheoryProSetup-{}",
        process::id()
    ));
    fs::create_dir(&bootstrap_directory)
        .map_err(|error| format!("Could not prepare the setup launcher: {error}"))?;

    let bootstrap_script = bootstrap_directory.join("Install-Offline-Bundle.ps1");
    if let Err(error) = fs::write(&bootstrap_script, include_str!("../bootstrap.ps1")) {
        let _ = fs::remove_dir_all(&bootstrap_directory);
        return Err(format!("Could not prepare the offline setup script: {error}"));
    }

    let result = Command::new("powershell.exe")
        .args(POWERSHELL_ARGS)
        .arg("-File")
        .arg(&bootstrap_script)
        .arg(executable)
        .status()
        .map_err(|error| format!("Could not start Windows PowerShell: {error}"));

    let _ = fs::remove_dir_all(&bootstrap_directory);
    result.map(|status| status.code().unwrap_or(1))
}

fn main() {
    match run() {
        Ok(code) => process::exit(code),
        Err(error) => {
            eprintln!("{error}");
            eprintln!("Press Enter to close.");
            let mut line = String::new();
            let _ = io::stdin().read_line(&mut line);
            process::exit(1);
        }
    }
}
