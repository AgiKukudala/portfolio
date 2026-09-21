package state

import "encoding/json"

func (m *Machine) ApplyBytes(data []byte) ([]byte, error) {
	var c Command
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, err
	}
	return json.Marshal(m.Apply(c))
}

func (m *Machine) Snapshot() ([]byte, error) { return json.Marshal(m) }
func (m *Machine) Restore(b []byte) error {
	next := New()
	if err := json.Unmarshal(b, next); err != nil {
		return err
	}
	if next.KV == nil {
		next.KV = make(map[string]string)
	}
	if next.Dedup == nil {
		next.Dedup = make(map[string]map[string]Cached)
	}
	*m = *next
	return nil
}
