
export const getBytesFromBiByteString = (s: string) => {
  const parts = s.split(' ')
  const num = parts[0] ?? '0'
  const unit = (parts[1] ?? 'b').charAt(0).toLowerCase()
  return Number(num) * (2 ** ('bkmgt'.indexOf(unit) * 10))
}

export const getHumanReadableByteString = (bytes: number, compact?: boolean) => {
  if (isNaN(bytes)) return 'NaN'
  if (bytes === 0 || bytes < 1) return `0 ${compact ? 'B' : 'bytes'}`
  const k = 1000
  const i = Math.floor(Math.log(bytes) / Math.log(k))

  let result =
    new Intl.NumberFormat(
      'en-US',
      {
        unit: ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte', 'petabyte'][i],
        notation: 'standard',
        style: 'unit',
        unitDisplay: 'short',
        maximumFractionDigits:
          i >= 3
            ? 2
            : 1
      }
    )
    .format(bytes / Math.pow(k, i))

  if (result.includes(' byte')) {
    result = result.replace(' byte', ' B')
  }

  if (compact) return i > 1000 ? `${Number(result.replaceAll('byte', '')) / 1000}kB` : result

  return result
}
