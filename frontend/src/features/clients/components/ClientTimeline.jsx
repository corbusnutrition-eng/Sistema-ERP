import { useEffect, useState, useCallback } from 'react'
import { MessageSquarePlus, User, Clock, Send, X, Pencil, Check } from 'lucide-react'
import api from '../../../api/axios'
import { formatSaleTableDate } from '../../../utils/datetime'

function NoteDateLabel({ iso }) {
  const label = formatSaleTableDate(iso)
  return (
    <span className="flex items-center gap-1 text-[11px] text-gray-400 shrink-0" title={label}>
      <Clock size={10} className="shrink-0" aria-hidden />
      {label}
    </span>
  )
}

export default function ClientTimeline({ clientId, clientName }) {
  const [notes, setNotes] = useState([])
  const [loading, setLoading] = useState(true)
  const [newNote, setNewNote] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const [editingNoteId, setEditingNoteId] = useState(null)
  const [editDraft, setEditDraft] = useState('')
  const [savingEditId, setSavingEditId] = useState(null)

  const fetchNotes = useCallback(async () => {
    if (!clientId) return
    setLoading(true)
    try {
      const { data } = await api.get(`/api/v1/client-notes/${clientId}`)
      setNotes(Array.isArray(data) ? data : [])
    } catch {
      setError('No se pudieron cargar las notas.')
    } finally {
      setLoading(false)
    }
  }, [clientId])

  useEffect(() => {
    fetchNotes()
  }, [fetchNotes])

  function startEdit(note) {
    setEditingNoteId(note.id)
    setEditDraft(note.note || '')
    setError(null)
  }

  function cancelEdit() {
    setEditingNoteId(null)
    setEditDraft('')
  }

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

  async function handleSaveEdit(noteId) {
    const trimmed = editDraft.trim()
    if (!trimmed) {
      setError('La nota no puede quedar vacía.')
      return
    }
    setSavingEditId(noteId)
    setError(null)
    try {
      const { data } = await api.patch(`/api/v1/client-notes/${clientId}/${noteId}`, {
        note: trimmed,
      })
      setNotes((prev) => prev.map((n) => (n.id === noteId ? data : n)))
      cancelEdit()
    } catch {
      setError('No se pudo actualizar la nota. Inténtalo de nuevo.')
    } finally {
      setSavingEditId(null)
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
          notes.map((note) => {
            const isEditing = editingNoteId === note.id
            const isSaving = savingEditId === note.id
            return (
              <div
                key={note.id}
                className="flex gap-3 p-3 bg-gray-50 rounded-xl border border-gray-100 hover:border-blue-100 transition-colors group"
              >
                <div className="w-7 h-7 rounded-full bg-blue-100 flex items-center justify-center shrink-0 mt-0.5">
                  <User size={12} className="text-blue-600" />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <span className="text-xs font-semibold text-gray-700 truncate pt-0.5">
                      {note.author_name || 'Usuario'}
                    </span>
                    <div className="flex items-center gap-1 shrink-0">
                      {!isEditing && (
                        <button
                          type="button"
                          onClick={() => startEdit(note)}
                          className="p-1 rounded-md text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                          title="Editar nota"
                          aria-label="Editar nota"
                        >
                          <Pencil size={12} />
                        </button>
                      )}
                      <NoteDateLabel iso={note.created_at} />
                    </div>
                  </div>

                  {isEditing ? (
                    <div className="space-y-2">
                      <textarea
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        rows={3}
                        disabled={isSaving}
                        className="w-full px-2.5 py-2 text-sm border border-blue-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/40 resize-none"
                        autoFocus
                      />
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          disabled={isSaving || !editDraft.trim()}
                          onClick={() => void handleSaveEdit(note.id)}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-45 disabled:cursor-not-allowed"
                        >
                          {isSaving ? (
                            <span className="w-3 h-3 rounded-full border-2 border-white border-t-transparent animate-spin" />
                          ) : (
                            <Check size={11} />
                          )}
                          Guardar
                        </button>
                        <button
                          type="button"
                          disabled={isSaving}
                          onClick={cancelEdit}
                          className="px-2 py-1 rounded-md text-[11px] font-medium text-gray-600 bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-45"
                        >
                          Cancelar
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-gray-600 leading-relaxed break-words">{note.note}</p>
                  )}
                </div>
              </div>
            )
          })}
      </div>
    </div>
  )
}
