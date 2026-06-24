/** Códigos telefónicos internacionales para selector de contacto (portal BaaS). */
export const PHONE_COUNTRY_OPTIONS = [
  { dialCode: '+593', flag: '🇪🇨', label: 'Ecuador', search: 'ecuador ec +593' },
  { dialCode: '+57', flag: '🇨🇴', label: 'Colombia', search: 'colombia co +57' },
  { dialCode: '+51', flag: '🇵🇪', label: 'Perú', search: 'peru pe +51' },
  { dialCode: '+52', flag: '🇲🇽', label: 'México', search: 'mexico mx +52' },
  { dialCode: '+54', flag: '🇦🇷', label: 'Argentina', search: 'argentina ar +54' },
  { dialCode: '+56', flag: '🇨🇱', label: 'Chile', search: 'chile cl +56' },
  { dialCode: '+58', flag: '🇻🇪', label: 'Venezuela', search: 'venezuela ve +58' },
  { dialCode: '+591', flag: '🇧🇴', label: 'Bolivia', search: 'bolivia bo +591' },
  { dialCode: '+595', flag: '🇵🇾', label: 'Paraguay', search: 'paraguay py +595' },
  { dialCode: '+598', flag: '🇺🇾', label: 'Uruguay', search: 'uruguay uy +598' },
  { dialCode: '+55', flag: '🇧🇷', label: 'Brasil', search: 'brasil brazil br +55' },
  { dialCode: '+1', flag: '🇺🇸', label: 'Estados Unidos', search: 'usa united states us +1' },
  { dialCode: '+34', flag: '🇪🇸', label: 'España', search: 'espana spain es +34' },
  { dialCode: '+502', flag: '🇬🇹', label: 'Guatemala', search: 'guatemala gt +502' },
  { dialCode: '+503', flag: '🇸🇻', label: 'El Salvador', search: 'el salvador sv +503' },
  { dialCode: '+504', flag: '🇭🇳', label: 'Hondoras', search: 'hondoras honduran hn +504' },
  { dialCode: '+505', flag: '🇳🇮', label: 'Nicaragua', search: 'nicaragua ni +505' },
  { dialCode: '+506', flag: '🇨🇷', label: 'Costa Rica', search: 'costa rica cr +506' },
  { dialCode: '+507', flag: '🇵🇦', label: 'Panamá', search: 'panama pa +507' },
  { dialCode: '+53', flag: '🇨🇺', label: 'Cuba', search: 'cuba cu +53' },
  { dialCode: '+809', flag: '🇩🇴', label: 'Rep. Dominicana', search: 'dominicana do +809' },
  { dialCode: '+44', flag: '🇬🇧', label: 'Reino Unido', search: 'uk united kingdom gb +44' },
  { dialCode: '+49', flag: '🇩🇪', label: 'Alemania', search: 'alemania germany de +49' },
  { dialCode: '+33', flag: '🇫🇷', label: 'Francia', search: 'francia france fr +33' },
  { dialCode: '+39', flag: '🇮🇹', label: 'Italia', search: 'italia italy it +39' },
]

export function phoneCountrySelectOptions() {
  return PHONE_COUNTRY_OPTIONS.map((o) => ({
    value: o.dialCode,
    label: `${o.flag} ${o.dialCode} ${o.label}`,
    searchText: `${o.label} ${o.search} ${o.dialCode} ${o.flag}`,
    flag: o.flag,
    dialCode: o.dialCode,
    country: o.label,
  }))
}

export function splitPhoneParts(fullPhone) {
  const raw = String(fullPhone || '').trim()
  if (!raw) return { dialCode: '+593', local: '' }
  const compact = raw.replace(/\s/g, '')
  if (compact.startsWith('+')) {
    const byLen = [...PHONE_COUNTRY_OPTIONS].sort(
      (a, b) => b.dialCode.length - a.dialCode.length,
    )
    for (const o of byLen) {
      if (compact.startsWith(o.dialCode)) {
        return {
          dialCode: o.dialCode,
          local: compact.slice(o.dialCode.length).replace(/\D/g, ''),
        }
      }
    }
    const m = compact.match(/^(\+\d{1,4})(\d*)$/)
    if (m) return { dialCode: m[1], local: m[2].replace(/\D/g, '') }
  }
  return { dialCode: '+593', local: compact.replace(/\D/g, '') }
}

export function mergePhoneParts(dialCode, local) {
  const prefix = String(dialCode || '+593').trim().startsWith('+')
    ? String(dialCode).trim()
    : `+${String(dialCode || '').replace(/\D/g, '')}`
  const digits = String(local || '').replace(/\D/g, '')
  if (!digits) return ''
  return `${prefix}${digits}`
}

export function whatsappDigits(phone) {
  return String(phone || '').replace(/\D/g, '')
}
