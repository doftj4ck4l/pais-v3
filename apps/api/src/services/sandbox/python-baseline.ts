export type PythonBaselineGroup = {
  label: string;
  packages: ReadonlyArray<{ spec: string; display?: string }>;
};

/**
 * Python packages installed with `--user` must remain importable in every
 * command the agent runs, not only in the installation request itself.
 */
export const PYTHON_RUNTIME_ENV: Readonly<Record<string, string>> = {
  HOME: "/workspace",
  PIP_ROOT_USER_ACTION: "ignore",
  PIP_DISABLE_PIP_VERSION_CHECK: "1",
  PYTHONUSERBASE: "/workspace/.local",
};

/** One source of truth for what acquisition installs and the prompt advertises. */
export const PYTHON_BASELINE: ReadonlyArray<PythonBaselineGroup> = [
  {
    label: "documents",
    packages: [
      { spec: "openpyxl==3.1.5" },
      { spec: "python-docx==1.2.0" },
      { spec: "python-pptx==1.0.2" },
      { spec: "pypdf==6.16.1" },
      { spec: "reportlab==4.2.5" },
    ],
  },
  {
    label: "images",
    packages: [
      { spec: "pillow==12.3.0" },
      { spec: "opencv-python-headless==5.0.0.93", display: "opencv" },
    ],
  },
  {
    label: "data",
    packages: [
      { spec: "numpy==2.5.2" },
      { spec: "pandas==3.0.5" },
      { spec: "scipy==1.18.0" },
      { spec: "scikit-learn==1.9.0" },
      { spec: "tabulate==0.10.0" },
    ],
  },
  {
    label: "charts",
    packages: [
      { spec: "matplotlib==3.11.1" },
      { spec: "seaborn==0.13.2" },
      { spec: "plotly==6.9.0" },
    ],
  },
  {
    label: "fetching",
    packages: [
      { spec: "requests==2.34.2" },
      { spec: "beautifulsoup4==4.15.0" },
      { spec: "lxml==6.1.1" },
    ],
  },
] as const;

export const PYTHON_BASELINE_SPECS = PYTHON_BASELINE.flatMap((group) =>
  group.packages.map((pkg) => pkg.spec),
);

export function describePythonBaseline(): string {
  return PYTHON_BASELINE.map(
    (group) =>
      `${group.label} (${group.packages.map((pkg) => pkg.display ?? pkg.spec.split("==", 1)[0]).join(", ")})`,
  ).join(", ");
}
