import type {
  RunsResponse,
  TrajectoryEvent,
  TaskMeta,
  DatasetIndex,
  DatasetItem,
  SftFilesIndex,
  SftRecordResponse,
} from "./types"

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} → ${res.status}`)
  return res.json() as Promise<T>
}

export const fetchRuns = () => getJson<RunsResponse>("/api/runs")

export const fetchTrajectory = (provider: string, model: string, task: string) =>
  getJson<TrajectoryEvent[]>(
    `/api/trajectory?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}&task=${encodeURIComponent(task)}`
  )

export const fetchMeta = (provider: string, model: string, task: string) =>
  getJson<TaskMeta | null>(
    `/api/meta?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}&task=${encodeURIComponent(task)}`
  )

export const screenshotUrl = (provider: string, model: string, task: string, file: string) =>
  `/screenshots/${encodeURIComponent(provider)}/${encodeURIComponent(model)}/${encodeURIComponent(task)}/${file.replace(/^screenshots\//, "")}`

export const fetchDataset = () => getJson<DatasetIndex>("/api/dataset")

export const fetchDatasetItems = (split: string, type: string) =>
  getJson<DatasetItem[]>(
    `/api/dataset/items?split=${encodeURIComponent(split)}&type=${encodeURIComponent(type)}`
  )

export const fetchSftFiles = () => getJson<SftFilesIndex>("/api/sft/files")

export const fetchSftRecord = (file: string, index: number) =>
  getJson<SftRecordResponse>(
    `/api/sft/record?file=${encodeURIComponent(file)}&index=${index}`
  )
