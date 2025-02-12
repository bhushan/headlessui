import {
  computed,
  defineComponent,
  h,
  onMounted,
  onUnmounted,
  ref,
  watch,

  // Types
  PropType,
  Fragment,
  Ref,
} from 'vue'
import { render } from '../../utils/render'
import { Hidden, Features as HiddenFeatures } from '../../internal/hidden'
import { dom } from '../../utils/dom'
import { focusIn, Focus, focusElement, FocusResult } from '../../utils/focus-management'
import { match } from '../../utils/match'
import { useTabDirection, Direction as TabDirection } from '../../hooks/use-tab-direction'
import { getOwnerDocument } from '../../utils/owner'
import { useEventListener } from '../../hooks/use-event-listener'
import { microTask } from '../../utils/micro-task'

enum Features {
  /** No features enabled for the focus trap. */
  None = 1 << 0,

  /** Ensure that we move focus initially into the container. */
  InitialFocus = 1 << 1,

  /** Ensure that pressing `Tab` and `Shift+Tab` is trapped within the container. */
  TabLock = 1 << 2,

  /** Ensure that programmatically moving focus outside of the container is disallowed. */
  FocusLock = 1 << 3,

  /** Ensure that we restore the focus when unmounting the focus trap. */
  RestoreFocus = 1 << 4,

  /** Enable all features. */
  All = InitialFocus | TabLock | FocusLock | RestoreFocus,
}

export let FocusTrap = Object.assign(
  defineComponent({
    name: 'FocusTrap',
    props: {
      as: { type: [Object, String], default: 'div' },
      initialFocus: { type: Object as PropType<HTMLElement | null>, default: null },
      features: { type: Number as PropType<Features>, default: Features.All },
      containers: {
        type: Object as PropType<Ref<Set<Ref<HTMLElement | null>>>>,
        default: ref(new Set()),
      },
    },
    inheritAttrs: false,
    setup(props, { attrs, slots, expose }) {
      let container = ref<HTMLElement | null>(null)

      expose({ el: container, $el: container })

      let ownerDocument = computed(() => getOwnerDocument(container))

      useRestoreFocus(
        { ownerDocument },
        computed(() => Boolean(props.features & Features.RestoreFocus))
      )
      let previousActiveElement = useInitialFocus(
        { ownerDocument, container, initialFocus: computed(() => props.initialFocus) },
        computed(() => Boolean(props.features & Features.InitialFocus))
      )
      useFocusLock(
        {
          ownerDocument,
          container,
          containers: props.containers,
          previousActiveElement,
        },
        computed(() => Boolean(props.features & Features.FocusLock))
      )

      let direction = useTabDirection()
      function handleFocus(e: FocusEvent) {
        let el = dom(container) as HTMLElement
        if (!el) return

        // TODO: Cleanup once we are using real browser tests
        let wrapper = process.env.NODE_ENV === 'test' ? microTask : (cb: Function) => cb()
        wrapper(() => {
          match(direction.value, {
            [TabDirection.Forwards]: () =>
              focusIn(el, Focus.First, { skipElements: [e.relatedTarget as HTMLElement] }),
            [TabDirection.Backwards]: () =>
              focusIn(el, Focus.Last, { skipElements: [e.relatedTarget as HTMLElement] }),
          })
        })
      }

      let recentlyUsedTabKey = ref(false)
      function handleKeyDown(e: KeyboardEvent) {
        if (e.key === 'Tab') {
          recentlyUsedTabKey.value = true
          requestAnimationFrame(() => {
            recentlyUsedTabKey.value = false
          })
        }
      }

      function handleBlur(e: FocusEvent) {
        let allContainers = new Set(props.containers?.value)
        allContainers.add(container)

        let relatedTarget = e.relatedTarget as HTMLElement | null
        if (!relatedTarget) return

        // Known guards, leave them alone!
        if (relatedTarget.dataset.headlessuiFocusGuard === 'true') {
          return
        }

        // Blur is triggered due to focus on relatedTarget, and the relatedTarget is not inside any
        // of the dialog containers. In other words, let's move focus back in!
        if (!contains(allContainers, relatedTarget)) {
          // Was the blur invoke via the keyboard? Redirect to the next in line.
          if (recentlyUsedTabKey.value) {
            focusIn(
              dom(container) as HTMLElement,
              match(direction.value, {
                [TabDirection.Forwards]: () => Focus.Next,
                [TabDirection.Backwards]: () => Focus.Previous,
              }) | Focus.WrapAround,
              { relativeTo: e.target as HTMLElement }
            )
          }

          // It was invoke via something else (e.g.: click, programmatically, ...). Redirect to the
          // previous active item in the FocusTrap
          else if (e.target instanceof HTMLElement) {
            focusElement(e.target)
          }
        }
      }

      return () => {
        let slot = {}
        let ourProps = { ref: container, onKeydown: handleKeyDown, onFocusout: handleBlur }
        let { features, initialFocus, containers: _containers, ...theirProps } = props

        return h(Fragment, [
          Boolean(features & Features.TabLock) &&
            h(Hidden, {
              as: 'button',
              type: 'button',
              'data-headlessui-focus-guard': true,
              onFocus: handleFocus,
              features: HiddenFeatures.Focusable,
            }),
          render({
            ourProps,
            theirProps: { ...attrs, ...theirProps },
            slot,
            attrs,
            slots,
            name: 'FocusTrap',
          }),
          Boolean(features & Features.TabLock) &&
            h(Hidden, {
              as: 'button',
              type: 'button',
              'data-headlessui-focus-guard': true,
              onFocus: handleFocus,
              features: HiddenFeatures.Focusable,
            }),
        ])
      }
    },
  }),
  { features: Features }
)

function useRestoreFocus(
  { ownerDocument }: { ownerDocument: Ref<Document | null> },
  enabled: Ref<boolean>
) {
  let restoreElement = ref<HTMLElement | null>(null)

  function captureFocus() {
    if (restoreElement.value) return
    restoreElement.value = ownerDocument.value?.activeElement as HTMLElement
  }

  // Restore the focus to the previous element
  function restoreFocusIfNeeded() {
    if (!restoreElement.value) return
    focusElement(restoreElement.value)
    restoreElement.value = null
  }

  onMounted(() => {
    watch(
      enabled,
      (newValue, prevValue) => {
        if (newValue === prevValue) return

        if (newValue) {
          // The FocusTrap has become enabled which means we're going to move the focus into the trap
          // We need to capture the current focus before we do that so we can restore it when done
          captureFocus()
        } else {
          restoreFocusIfNeeded()
        }
      },
      { immediate: true }
    )
  })

  // Restore the focus when we unmount the component
  onUnmounted(restoreFocusIfNeeded)
}

function useInitialFocus(
  {
    ownerDocument,
    container,
    initialFocus,
  }: {
    ownerDocument: Ref<Document | null>
    container: Ref<HTMLElement | null>
    initialFocus?: Ref<HTMLElement | null>
  },
  enabled: Ref<boolean>
) {
  let previousActiveElement = ref<HTMLElement | null>(null)

  let mounted = ref(false)
  onMounted(() => (mounted.value = true))
  onUnmounted(() => (mounted.value = false))

  onMounted(() => {
    watch(
      // Handle initial focus
      [container, initialFocus, enabled],
      (newValues, prevValues) => {
        if (newValues.every((value, idx) => prevValues?.[idx] === value)) return
        if (!enabled.value) return

        let containerElement = dom(container)
        if (!containerElement) return

        // Delaying the focus to the next microtask ensures that a few conditions are true:
        // - The container is rendered
        // - Transitions could be started
        // If we don't do this, then focusing an element will immediately cancel any transitions. This
        // is not ideal because transitions will look broken.
        // There is an additional issue with doing this immediately. The FocusTrap is used inside a
        // Dialog, the Dialog is rendered inside of a Portal and the Portal is rendered at the end of
        // the `document.body`. This means that the moment we call focus, the browser immediately
        // tries to focus the element, which will still be at the bodem resulting in the page to
        // scroll down. Delaying this will prevent the page to scroll down entirely.
        microTask(() => {
          if (!mounted.value) {
            return
          }

          let initialFocusElement = dom(initialFocus)

          let activeElement = ownerDocument.value?.activeElement as HTMLElement

          if (initialFocusElement) {
            if (initialFocusElement === activeElement) {
              previousActiveElement.value = activeElement
              return // Initial focus ref is already the active element
            }
          } else if (containerElement!.contains(activeElement)) {
            previousActiveElement.value = activeElement
            return // Already focused within Dialog
          }

          // Try to focus the initialFocus ref
          if (initialFocusElement) {
            focusElement(initialFocusElement)
          } else {
            if (focusIn(containerElement!, Focus.First | Focus.NoScroll) === FocusResult.Error) {
              console.warn('There are no focusable elements inside the <FocusTrap />')
            }
          }

          previousActiveElement.value = ownerDocument.value?.activeElement as HTMLElement
        })
      },
      { immediate: true, flush: 'post' }
    )
  })

  return previousActiveElement
}

function useFocusLock(
  {
    ownerDocument,
    container,
    containers,
    previousActiveElement,
  }: {
    ownerDocument: Ref<Document | null>
    container: Ref<HTMLElement | null>
    containers: Ref<Set<Ref<HTMLElement | null>>>
    previousActiveElement: Ref<HTMLElement | null>
  },
  enabled: Ref<boolean>
) {
  // Prevent programmatically escaping
  useEventListener(
    ownerDocument.value?.defaultView,
    'focus',
    (event) => {
      if (!enabled.value) return

      let allContainers = new Set(containers?.value)
      allContainers.add(container)

      let previous = previousActiveElement.value
      if (!previous) return

      let toElement = event.target as HTMLElement | null

      if (toElement && toElement instanceof HTMLElement) {
        if (!contains(allContainers, toElement)) {
          event.preventDefault()
          event.stopPropagation()
          focusElement(previous)
        } else {
          previousActiveElement.value = toElement
          focusElement(toElement)
        }
      } else {
        focusElement(previousActiveElement.value)
      }
    },
    true
  )
}

function contains(containers: Set<Ref<HTMLElement | null>>, element: HTMLElement) {
  for (let container of containers) {
    if (container.value?.contains(element)) return true
  }

  return false
}
