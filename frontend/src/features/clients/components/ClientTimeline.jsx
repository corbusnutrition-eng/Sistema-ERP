import { useEffect, useState, useCallback } from 'react'
import { MessageSquarePlus, User, Clock, Send, X } from 'lucide-react'
import api from '../../../api/axios'
import { formatRelativeTimeEcuador } from '../../../utils/datetime'

function formatRelativeTime(dateStr) {
  const rel = formatRelativeTimeEcuador(dateStr)
  if (rel === 'Ahora') return 'Ahora mismo'
  if (rel.startsWith('Hace ') && rel.endsWith(' h')) return rel.replace(' h', 'h')
  if (rel.startsWith('Hace ') && rel.endsWith(' d')) {
    const n = parseInt(rel.replace(/\D/g, ''), 10)
    if (n === 1) return 'Ayer'
    return `Hace ${n} días`
  }
  return rel
}

export default function ClientTimeline({ clientId, clientName }) {
  const [notes, setNotes] = useState([])
  const [loading, setLoading] = useState(true)
  const [newNote, setNewNote] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)

  const fetchNotes = useCallback(async () => {
    if (!clientId) return
    setLoading(true)
    try {
      const { data } = await api.get(`/api/v1/client-notes/${clientId}`)
      setNotes(data)
    } catch {
      setError('No se pudieron cargar las notas.')
    } finally {
      setLoading(false)
    }
  }, [clientId])

  useEffect(() => {
    fetchNotes()
  }, [fetchNotes])

  async function handleSubmit(e) {
    e.preventDefault()
    if (!newNote.trim()) return
    setSending(true)
    setError(null)
    try {
      const { data } = await api.post('/api/v1/client-notes/', {
        client_id: clientId,
        note: newNote.trim(),
      })
      setNotes((prev) => [data, ...prev])
      setNewNote('')
    } catch {
      setError('No se pudo guardar la nota. Inténtalo de nuevo.')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <div className="w-7 h-7 rounded-lg bg-blue-100 flex items-center justify-center shrink-0">
          <MessageSquarePlus size={14} className="text-blue-600" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Seguimiento CRM</h3>
          {clientName && (
            <p className="text-xs text-gray-500">{clientName}</p>
          )}
        </div>
      </div>

      {/* New note form */}
      <form onSubmit={handleSubmit} className="mb-4">
        <div className="relative">
          <textarea
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            placeholder="Escribe una nota sobre este cliente…"
            rows={3}
            className="w-full px-3 py-2.5 pr-10 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none transition placeholder-gray-400"
          />
          <button
            type="submit"
            disabled={sending || !newNote.trim()}
            className="absolute bottom-2.5 right-2.5 p-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="Enviar nota"
          >
            {sending ? (
              <span className="w-3.5 h-3.5 rounded-full border-2 border-white border-t-transparent animate-spin block" />
            ) : (
              <Send size={13} />
            )}
          </button>
        </div>
        {error && (
          <p className="mt-1.5 text-xs text-red-600 flex items-center gap-1">
            <X size={12} />
            {error}
          </p>
        )}
      </form>

      {/* Timeline */}
      <div className="flex-1 overflow-y-auto space-y-3 pr-1">
        {loading && (
          <div className="flex items-center justify-center py-8 text-gray-400 text-sm gap-2">
            <span className="w-4 h-4 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
            Cargando notas…
          </div>
        )}

        {!loading && notes.length === 0 && (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mb-3">
              <MessageSquarePlus size={22} className="text-gray-300" />
            </div>
            <p className="text-sm text-gray-400">Sin notas aún</p>
            <p className="text-xs text-gray-300 mt-0.5">Sé el primero en añadir un seguimiento</p>
          </div>
        )}

        {!loading &&
          notes.map((note) => (
            <div
              key={note.id}
              className="flex gap-3 p-3 bg-gray-50 rounded-xl border border-gray-100 hover:border-blue-100 transition-colors"
            >
              {/* Avatar */}
              <div className="w-7 h-7 rounded-full bg-blue-100 flex items-center justify-center shrink-0 mt-0.5">
                <User size={12} className="text-blue-600" />
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-xs font-semibold text-gray-700 truncate">
                    {note.author_name || 'Usuario'}
                  </span>
                  <span className="flex items-center gap-1 text-xs text-gray-400 shrink-0">
                    <Clock size={10} />
                    {formatRelativeTime(note.created_at)}
                  </span>
                </div>
                <p className="text-sm text-gray-600 leading-relaxed break-words">{note.note}</p>
              </div>
            </div>
          ))}
      </div>
    </div>
  )
}
