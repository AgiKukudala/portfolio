// Package state implements deterministic commands; its owner supplies synchronization.
package state

type Command struct{ Op, Key, Value, Expected, ClientID, RequestID string }
type Result struct {
	Value          string
	Found, Success bool
	Error          string
}
type Cached struct {
	Command Command
	Result  Result
}
type Machine struct {
	KV    map[string]string
	Dedup map[string]map[string]Cached
}

func New() *Machine {
	return &Machine{KV: make(map[string]string), Dedup: make(map[string]map[string]Cached)}
}
func (m *Machine) Apply(c Command) Result {
	mutation := c.Op == "put" || c.Op == "delete" || c.Op == "cas"
	if mutation && c.ClientID != "" && c.RequestID != "" {
		if cached, ok := m.Dedup[c.ClientID][c.RequestID]; ok {
			if cached.Command != c {
				return Result{Error: "request_id_reused"}
			}
			return cached.Result
		}
	}
	r := m.execute(c)
	if mutation && c.ClientID != "" && c.RequestID != "" {
		if m.Dedup[c.ClientID] == nil {
			m.Dedup[c.ClientID] = make(map[string]Cached)
		}
		m.Dedup[c.ClientID][c.RequestID] = Cached{c, r}
	}
	return r
}
func (m *Machine) execute(c Command) Result {
	v, found := m.KV[c.Key]
	r := Result{Value: v, Found: found}
	switch c.Op {
	case "noop":
	case "get":
		r.Success = true
	case "put":
		m.KV[c.Key] = c.Value
		r.Success = true
	case "delete":
		delete(m.KV, c.Key)
		r.Success = true
	case "cas":
		// Evaluate the condition here, in replicated order, never in the RPC handler.
		if found && v == c.Expected {
			m.KV[c.Key] = c.Value
			r.Success = true
		}
	default:
		r.Error = "unknown operation"
	}
	return r
}
