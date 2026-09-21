// Package storage provides a small, synchronous, atomic Raft store.
package storage

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"asterkv/internal/raft"

	"golang.org/x/sys/unix"
)

type File struct {
	dir  string
	lock *os.File
}
type envelope struct {
	Version int
	SHA256  string
	Payload json.RawMessage
}

func Open(dir string) (*File, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, "LOCK"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		f.Close()
		return nil, fmt.Errorf("data directory already in use: %w", err)
	}
	return &File{dir: dir, lock: f}, nil
}
func (f *File) Close() error { return f.lock.Close() }
func (f *File) Load() (raft.Durable, error) {
	var d raft.Durable
	b, err := os.ReadFile(filepath.Join(f.dir, "raft.json"))
	if errors.Is(err, os.ErrNotExist) {
		return d, nil
	}
	if err != nil {
		return d, err
	}
	var e envelope
	if err = json.Unmarshal(b, &e); err != nil {
		return d, err
	}
	sum := sha256.Sum256(e.Payload)
	if e.Version != 1 || hex.EncodeToString(sum[:]) != e.SHA256 {
		return d, errors.New("unsupported or corrupt Raft state")
	}
	err = json.Unmarshal(e.Payload, &d)
	return d, err
}
func (f *File) Save(d raft.Durable) error {
	b, err := json.Marshal(d)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(b)
	b, err = json.Marshal(envelope{1, hex.EncodeToString(sum[:]), b})
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(f.dir, ".raft-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if _, err = tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err = tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	// Rename publishes metadata and log together; directory sync persists that rename.
	if err = os.Rename(name, filepath.Join(f.dir, "raft.json")); err != nil {
		return err
	}
	dir, err := os.Open(f.dir)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
