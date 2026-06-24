import { useMemo, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

function SortablePortalSection({ id, children }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`relative touch-manipulation ${isDragging ? 'opacity-35' : ''}`}
    >
      {typeof children === 'function'
        ? children({ dragHandleProps: { ...attributes, ...listeners }, isDragging })
        : children}
    </div>
  )
}

/**
 * Lista vertical reordenable de secciones del portal (acordeones).
 * El arrastre solo se activa desde el handle (⋮⋮) para no interferir con el scroll móvil.
 */
export default function PortalAccordionSortableList({ order, onOrderChange, sections }) {
  const [activeId, setActiveId] = useState(null)

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const visibleIds = useMemo(
    () => order.filter((id) => typeof sections[id] === 'function'),
    [order, sections],
  )

  function handleDragStart(event) {
    setActiveId(String(event.active.id))
  }

  function handleDragEnd(event) {
    const { active, over } = event
    setActiveId(null)
    if (!over || active.id === over.id) return
    const oldIndex = order.indexOf(active.id)
    const newIndex = order.indexOf(over.id)
    if (oldIndex < 0 || newIndex < 0) return
    onOrderChange(arrayMove(order, oldIndex, newIndex))
  }

  function handleDragCancel() {
    setActiveId(null)
  }

  const activeSection =
    activeId && typeof sections[activeId] === 'function'
      ? sections[activeId]({ dragHandleProps: {}, isDragging: true })
      : null

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <SortableContext items={visibleIds} strategy={verticalListSortingStrategy}>
        {visibleIds.map((id) => (
          <SortablePortalSection key={id} id={id}>
            {({ dragHandleProps, isDragging }) =>
              sections[id]?.({ dragHandleProps, isDragging }) ?? null
            }
          </SortablePortalSection>
        ))}
      </SortableContext>
      <DragOverlay dropAnimation={{ duration: 180, easing: 'ease-out' }}>
        {activeSection ? (
          <div className="cursor-grabbing opacity-95 drop-shadow-[0_22px_48px_rgba(0,0,0,0.65)] ring-1 ring-cyan-400/40">
            {activeSection}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
